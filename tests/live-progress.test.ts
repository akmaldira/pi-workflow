/**
 * Live status streaming: while a subagent is running, the caller should be
 * able to see a one-line "what is it doing right now" update — the same
 * gap pi-subagents closes with its onUpdate/fireUpdate plumbing.
 *
 * This spawns a *real* child process (a fake `pi` binary that emits genuine
 * JSONL protocol events over stdout) via PI_SUBAGENT_PI_BINARY, so the test
 * exercises execution.ts's actual event-parsing loop rather than a mocked
 * runSingleAgent. Scripted, not a live model call — deterministic and fast.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSingleAgent } from "../extensions/execution.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../extensions/pi-spawn.ts";
import { formatProgressLine } from "../extensions/utils.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { AgentProgress } from "../extensions/types.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/tmp/worker.md",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

/**
 * Writes a fake `pi` CLI: a node script that ignores its args and prints a
 * scripted sequence of JSONL protocol events to stdout, one per line, with a
 * small delay between each so the parent's line-by-line reader genuinely
 * processes them as separate events (not one buffered write).
 */
function writeFakePiBinary(dir: string, events: Record<string, unknown>[]): string {
	const scriptPath = path.join(dir, "fake-pi.cjs");
	const body = `#!${process.execPath}
const events = ${JSON.stringify(events)};
let i = 0;
function next() {
	if (i >= events.length) { process.exit(0); return; }
	process.stdout.write(JSON.stringify(events[i]) + "\\n");
	i++;
	setTimeout(next, 5);
}
next();
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

describe("live progress streaming (execution.ts onProgress)", () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-progress-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		process.env = { ...originalEnv };
	});

	it("fires onProgress with the currently-running tool as each event arrives", async () => {
		const scriptPath = writeFakePiBinary(tempDir, [
			{ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } },
			{ type: "tool_execution_end", toolName: "bash" },
			{ type: "tool_execution_start", toolName: "read", args: { path: "/src/index.ts" } },
			{ type: "tool_execution_end", toolName: "read" },
			{ type: "turn_end", turnCount: 1, message: { usage: { input: 10, output: 5 }, stopReason: "end" } },
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
		]);
		// PI_SUBAGENT_PI_BINARY names a single command (no shell, no args
		// splitting), so the fake binary carries its own node shebang and is
		// pointed to directly.
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const snapshots: AgentProgress[] = [];
		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "progress-test-1",
			onProgress: (progress) => snapshots.push(progress),
		});

		expect(result.exitCode).toBe(0);
		expect(snapshots.length).toBeGreaterThan(0);

		// At least one snapshot should show bash running, and one should show
		// read running — i.e. currentTool reflects the live event, not just
		// the final state.
		const bashSnapshot = snapshots.find((s) => s.currentTool === "bash");
		const readSnapshot = snapshots.find((s) => s.currentTool === "read");
		expect(bashSnapshot).toBeDefined();
		expect(readSnapshot).toBeDefined();
		expect(formatProgressLine(bashSnapshot!)).toMatch(/^→ bash/);
		expect(formatProgressLine(readSnapshot!)).toMatch(/^→ read/);

		// After tool_execution_end, currentTool clears so a caller doesn't show
		// a stale "still running bash" after it has actually finished.
		const afterEndSnapshot = snapshots[snapshots.length - 1];
		expect(afterEndSnapshot.currentTool).toBeUndefined();
	});

	it("does not fire onProgress when the caller does not ask for it", async () => {
		const scriptPath = writeFakePiBinary(tempDir, [
			{ type: "tool_execution_start", toolName: "bash", args: {} },
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
		]);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		// No onProgress passed — must not throw, must still complete normally.
		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "progress-test-2",
		});
		expect(result.exitCode).toBe(0);
	});
});

describe("formatProgressLine", () => {
	it("shows the current tool and a truncated args preview", () => {
		const line = formatProgressLine({
			currentTool: "bash",
			currentToolArgs: '{"command":"npm test"}',
			toolCount: 1,
			tokens: 0,
		});
		expect(line).toBe('→ bash {"command":"npm test"}');
	});

	it("truncates long args previews to keep the line short", () => {
		const longArgs = "x".repeat(200);
		const line = formatProgressLine({ currentTool: "bash", currentToolArgs: longArgs, toolCount: 1, tokens: 0 });
		expect(line.length).toBeLessThan(80);
		expect(line).toContain("…");
	});

	it("falls back to a thinking summary between tool calls", () => {
		const line = formatProgressLine({ toolCount: 3, tokens: 100 });
		expect(line).toBe("thinking… (3 tool calls so far)");
	});

	it("falls back to starting… before any tool has run", () => {
		const line = formatProgressLine({ toolCount: 0, tokens: 0 });
		expect(line).toBe("starting…");
	});
});
