/**
 * agent_end protocol-limit degradation: a long, image-heavy subagent run can
 * make the final agent_end line (which replays the whole session history as
 * one JSON line) exceed MAX_CHILD_PENDING_LINE_BYTES even though every
 * individual message_end/tool_result_end line stayed well under it. Since
 * execution.ts already collected every one of those messages incrementally
 * before agent_end ever arrived, this must not be treated as a technical
 * failure that aborts the whole workflow — the run genuinely completed.
 *
 * Spawns a real child process (a fake `pi` binary), same pattern as
 * live-progress.test.ts, so this exercises execution.ts's actual
 * BoundedLineReader wiring rather than a mocked runSingleAgent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSingleAgent } from "../extensions/execution.ts";
import { MAX_CHILD_PENDING_LINE_BYTES } from "../extensions/child-protocol.ts";
import { classifySingleResultFailure } from "../extensions/failure-classifier.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../extensions/pi-spawn.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "extractor",
		description: "test agent",
		systemPrompt: "You are an extractor.",
		source: "user",
		filePath: "/tmp/extractor.md",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

/**
 * Fake `pi` binary: emits a scripted sequence of small (incrementally-safe)
 * message_end/tool_result_end events, then one deliberately oversized
 * agent_end line (>16MB, no embedded newline) that replays them all plus
 * padding — mirroring the real agent-loop behavior of dumping the entire
 * session history into a single agent_end event.
 *
 * Uses fs.writeSync(1, ...) for the oversized write specifically: a plain
 * process.stdout.write() of a multi-MB string can be buffered and racing
 * against process.exit() truncates it before the pipe flushes, which would
 * make this test flaky. A synchronous fd write has no such race.
 */
function writeFakePiBinaryWithOversizedAgentEnd(dir: string): string {
	const scriptPath = path.join(dir, "fake-pi-agent-end-overflow.cjs");
	const oversizedBytes = MAX_CHILD_PENDING_LINE_BYTES + 1024 * 1024; // 1MB past the limit
	const body = `#!${process.execPath}
const fs = require("node:fs");

const smallEvents = [
	{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "extract data from these images" }] } },
	{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "read image 1" }] } },
	{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "read image 2" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "extraction complete" }] } },
	{ type: "turn_end", turnCount: 1, message: { usage: { input: 10, output: 5 }, stopReason: "end" } },
];

let i = 0;
function next() {
	if (i >= smallEvents.length) {
		// The oversized agent_end line: one JSON line, no embedded newline,
		// padded past the 16MB reader limit. Written synchronously so it is
		// fully in the pipe before we exit.
		const padding = "x".repeat(${oversizedBytes});
		const agentEnd = JSON.stringify({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: padding }] }],
		});
		fs.writeSync(1, agentEnd + "\\n");
		process.exit(0);
		return;
	}
	process.stdout.write(JSON.stringify(smallEvents[i]) + "\\n");
	i++;
	setTimeout(next, 5);
}
next();
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

/** Same shape, but the oversized line is NOT agent_end — a plain assistant
 * message_end line padded past the limit. This must still be treated as a
 * technical failure: an oversized non-agent_end line is genuinely
 * pathological (something is producing an unbounded single message), not
 * the expected "whole-history replay grew past the cap" shape. */
function writeFakePiBinaryWithOversizedMessageEnd(dir: string): string {
	const scriptPath = path.join(dir, "fake-pi-message-end-overflow.cjs");
	const oversizedBytes = MAX_CHILD_PENDING_LINE_BYTES + 1024 * 1024;
	const body = `#!${process.execPath}
const fs = require("node:fs");
const padding = "x".repeat(${oversizedBytes});
const messageEnd = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: padding }] },
});
fs.writeSync(1, messageEnd + "\\n");
process.exit(0);
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

describe("agent_end protocol-limit degradation", () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-end-overflow-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		process.env = { ...originalEnv };
	});

	it("does not classify an oversized agent_end line as a technical failure when messages were already collected incrementally", async () => {
		const scriptPath = writeFakePiBinaryWithOversizedAgentEnd(tempDir);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "extract data", {
			runId: "agent-end-overflow-1",
		});

		// The run completed cleanly from the caller's point of view: no error,
		// no failureClass technical, exit code 0.
		expect(result.exitCode).toBe(0);
		expect(result.failureClass).toBe("none");
		expect(result.error).toBeUndefined();
		expect(result.errorMessage).toBeUndefined();
		expect(result.protocolError).toBeUndefined();

		// The incrementally-collected messages are intact: the small events
		// before the oversized agent_end line all made it through message_end/
		// tool_result_end, which is what makes the degradation safe.
		expect(result.messages).toBeDefined();
		expect(result.messages!.length).toBe(4); // user, tool_result x2, assistant
		expect(result.messages!.some((m) => m.role === "user")).toBe(true);
		expect(result.messages!.some((m) => m.role === "assistant")).toBe(true);
		expect(result.messages!.filter((m) => m.role === "toolResult").length).toBe(2);

		// finalOutput comes from the real (small) assistant message, not from
		// the giant padded agent_end blob that got dropped.
		expect(result.finalOutput).toBe("extraction complete");
	});

	it("still classifies an oversized non-agent_end line as a technical failure", async () => {
		const scriptPath = writeFakePiBinaryWithOversizedMessageEnd(tempDir);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "message-end-overflow-1",
		});

		expect(result.failureClass).toBe("technical");
		expect(result.failureCode).toBe("protocol-limit");
		expect(result.error).toBeDefined();
	});

	it("classifier: agent_end overflow with empty incremental messages is still technical (nothing to fall back on)", () => {
		const classification = classifySingleResultFailure({
			agent: "worker",
			task: "t",
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			protocolError: {
				code: "protocol_output_limit",
				stream: "stdout",
				limitBytes: MAX_CHILD_PENDING_LINE_BYTES,
				observedBytes: MAX_CHILD_PENDING_LINE_BYTES + 1,
				diagnosticPrefix: '{"type":"agent_end","messages":[',
				diagnosticTail: "",
			},
		});

		expect(classification.class).toBe("technical");
		expect(classification.code).toBe("protocol-limit");
	});

	it("classifier: agent_end overflow with populated incremental messages degrades to none", () => {
		const classification = classifySingleResultFailure({
			agent: "worker",
			task: "t",
			exitCode: 1,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] as never,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			protocolError: {
				code: "protocol_output_limit",
				stream: "stdout",
				limitBytes: MAX_CHILD_PENDING_LINE_BYTES,
				observedBytes: MAX_CHILD_PENDING_LINE_BYTES + 1,
				diagnosticPrefix: '{"type":"agent_end","messages":[',
				diagnosticTail: "",
			},
		});

		expect(classification.class).toBe("none");
	});

	it("classifier: a non-agent_end protocol limit stays technical even with populated messages", () => {
		const classification = classifySingleResultFailure({
			agent: "worker",
			task: "t",
			exitCode: 1,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] as never,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			protocolError: {
				code: "protocol_output_limit",
				stream: "stdout",
				limitBytes: MAX_CHILD_PENDING_LINE_BYTES,
				observedBytes: MAX_CHILD_PENDING_LINE_BYTES + 1,
				diagnosticPrefix: '{"type":"message_end","message":{',
				diagnosticTail: "",
			},
		});

		expect(classification.class).toBe("technical");
		expect(classification.code).toBe("protocol-limit");
	});
});
