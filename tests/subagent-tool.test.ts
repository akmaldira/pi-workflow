/**
 * Tests for the subagent tool registration, execution, and channel wiring.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSingleAgent } from "../extensions/execution.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import registerSubagentExtension from "../extensions/index.ts";

vi.mock("../extensions/execution.ts", () => ({
	runSingleAgent: vi.fn(),
}));

describe("subagent tool integration", () => {
	let tempDir: string;
	let registeredTool: any;
	let globalManagerInstance: WorkflowManager | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-test-"));
		// Write a stub agent in project agents dir
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "stub.md"),
			"---\nname: stub\ndescription: stub agent\n---\n\nStub agent prompt body.\n",
		);

		// Capture the registered tool
		const piMock = {
			registerTool: (tool: any) => {
				if (tool.name === "subagent") {
					registeredTool = tool;
				}
			},
			getActiveTools: () => [],
			setActiveTools: () => {},
			on: () => {},
			getAllTools: () => [],
			registerCommand: () => {},
		} as unknown as ExtensionAPI;

		// We need to capture the globalWorkflowManager. It's instantiated inside the default export.
		// To intercept it, we can spy on WorkflowManager prototype and call the original methods.
		globalManagerInstance = undefined;
		const origRegisterRun = WorkflowManager.prototype.registerRun;
		const origMarkAgentStart = WorkflowManager.prototype.markAgentStart;
		const origMarkAgentEnd = WorkflowManager.prototype.markAgentEnd;
		const origCompleteRun = WorkflowManager.prototype.completeRun;

		vi.spyOn(WorkflowManager.prototype, "registerRun").mockImplementation(function (
			this: WorkflowManager,
			runId,
			meta,
		) {
			globalManagerInstance = this;
			return origRegisterRun.call(this, runId, meta);
		});
		vi.spyOn(WorkflowManager.prototype, "markAgentStart").mockImplementation(function (
			this: WorkflowManager,
			runId,
			phaseIndex,
			agent,
		) {
			origMarkAgentStart.call(this, runId, phaseIndex, agent);
		});
		vi.spyOn(WorkflowManager.prototype, "markAgentEnd").mockImplementation(function (
			this: WorkflowManager,
			runId,
			agentId,
			status,
			result,
			error,
			tokens,
			durationMs,
		) {
			origMarkAgentEnd.call(this, runId, agentId, status, result, error, tokens, durationMs);
		});
		vi.spyOn(WorkflowManager.prototype, "completeRun").mockImplementation(function (
			this: WorkflowManager,
			runId,
			result,
			error,
		) {
			origCompleteRun.call(this, runId, result, error);
		});
		vi.spyOn(WorkflowManager.prototype, "watchSession").mockImplementation(function (
			this: WorkflowManager,
			runId,
			agentId,
			sessionFile,
		) {
			// No-op to avoid filesystem watch in tests
		});

		registerSubagentExtension(piMock);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers subagent run in manager and configures filesystem channel", async () => {
		const mockResult = {
			agent: "stub",
			task: "do work",
			exitCode: 0,
			messages: [],
			usage: { input: 10, output: 20 },
		};
		vi.mocked(runSingleAgent).mockResolvedValue(mockResult as any);

		const ctx = {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: undefined,
			model: "test-model",
		} as unknown as ExtensionContext;

		const params = {
			agent: "stub",
			task: "do work",
			cwd: tempDir,
		};

		const res = await registeredTool.execute("call-1", params, undefined, undefined, ctx);

		// Verify tool output
		expect(res.content).toBeDefined();

		// Verify run single agent was called with channel env vars
		expect(runSingleAgent).toHaveBeenCalled();
		const spawnOptions = vi.mocked(runSingleAgent).mock.calls[0][3];
		expect(spawnOptions.sessionFile).toContain(".pi-workflow/sessions/subagent-");
		expect(spawnOptions.extraEnv).toBeDefined();
		expect(spawnOptions.extraEnv!.PI_WORKFLOW_CHANNEL_DIR).toContain(".pi-workflow/channels/subagent-");
		expect(spawnOptions.extraEnv!.PI_WORKFLOW_RUN_ID).toContain("subagent-");

		// Verify WorkflowManager tracking
		expect(globalManagerInstance).toBeDefined();
		const runs = globalManagerInstance!.listRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].workflowName).toBe("subagent: stub");
		expect(runs[0].status).toBe("completed");
		expect(runs[0].agents).toHaveLength(1);
		expect(runs[0].agents[0].label).toBe("stub (delegate)");
		expect(runs[0].agents[0].status).toBe("done");
	});

	it("streams live status via onUpdate while the subagent runs (single mode)", async () => {
		// runSingleAgent is mocked wholesale in this suite, so simulate what the
		// real implementation does: call options.onProgress a couple of times
		// before resolving — the tool must forward each of those to its own
		// onUpdate callback so the chat panel shows live status, not just the
		// final result.
		vi.mocked(runSingleAgent).mockImplementation(async (_cwd, _agent, _task, options: any) => {
			options.onProgress?.({
				index: 0,
				agent: "stub",
				status: "running",
				task: "do work",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 0,
				durationMs: 5,
				currentTool: "bash",
				currentToolArgs: '{"command":"npm test"}',
			});
			return {
				agent: "stub",
				task: "do work",
				exitCode: 0,
				messages: [],
				usage: { input: 10, output: 20 },
			} as any;
		});

		const ctx = {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: undefined,
			model: "test-model",
		} as unknown as ExtensionContext;

		const updates: any[] = [];
		const onUpdate = (partial: any) => updates.push(partial);

		await registeredTool.execute("call-1", { agent: "stub", task: "do work", cwd: tempDir }, undefined, onUpdate, ctx);

		expect(updates.length).toBeGreaterThan(0);
		const text = updates[0].content[0].text as string;
		expect(text).toContain("stub:");
		expect(text).toContain("→ bash");
	});

	it("does not throw when no onUpdate is supplied", async () => {
		vi.mocked(runSingleAgent).mockImplementation(async (_cwd, _agent, _task, options: any) => {
			// Real runSingleAgent guards onProgress with `?.()`; a mock that calls
			// it unconditionally would crash here if the tool ever passed
			// undefined through incorrectly instead of omitting the option.
			options.onProgress?.({ toolCount: 0, tokens: 0, durationMs: 0, recentTools: [], recentOutput: [], index: 0, agent: "stub", status: "running", task: "t" });
			return { agent: "stub", task: "do work", exitCode: 0, messages: [], usage: { input: 0, output: 0 } } as any;
		});

		const ctx = {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: undefined,
			model: "test-model",
		} as unknown as ExtensionContext;

		await expect(
			registeredTool.execute("call-1", { agent: "stub", task: "do work", cwd: tempDir }, undefined, undefined, ctx),
		).resolves.toBeDefined();
	});

	it("detaches instead of deadlocking when the child asks the supervisor a question", async () => {
		// Regression test for the ask_supervisor deadlock: a prior fix landed the
		// intercom-emitter wiring in execution.ts but a git-checkout accident during
		// cleanup silently reverted the index.ts half (the poller never emitted
		// INTERCOM_DETACH_REQUEST_EVENT), so the deadlock was never actually fixed
		// even though tests passed. This exercises the real poller → real channel
		// filesystem → real event emitter path end to end, so a similar accidental
		// revert of index.ts's wiring cannot pass silently again.
		//
		// runSingleAgent is scripted to behave like the real implementation would
		// under detach: it writes a request file to the channel dir it was given,
		// then races process completion against the detach signal. Since nothing
		// ever answers the request file directly (no reply is written), the *only*
		// way this resolves quickly is via detach — without it, the mock's own
		// timeout below would fire and the test would see the slow path.
		const SLOW_MS = 5000;

		vi.mocked(runSingleAgent).mockImplementation(async (_cwd, _agent, _task, options: any) => {
			const channelDir = options.extraEnv?.PI_WORKFLOW_CHANNEL_DIR;
			expect(channelDir).toBeTruthy();

			// Simulate the child writing a supervisor request (what ask_supervisor's
			// ChannelClient.ask() does), and simulate execution.ts's real behavior:
			// race the (mocked, slow) process exit against the detach signal that
			// options.intercomEvents fires when the poller sees the request.
			const requestsDir = path.join(channelDir, "requests");
			fs.mkdirSync(requestsDir, { recursive: true });
			fs.writeFileSync(
				path.join(requestsDir, "req-test.json"),
				JSON.stringify({
					type: "channel.request",
					id: "req-test",
					createdAt: Date.now(),
					runId: options.runId,
					agent: "stub",
					kind: "supervisor",
					question: "Should I proceed?",
					expectsReply: true,
				}),
			);

			const fullUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			return new Promise((resolve) => {
				const slowTimer = setTimeout(() => {
					resolve({ agent: "stub", task: "do work", exitCode: 0, messages: [], usage: fullUsage });
				}, SLOW_MS);

				if (options.allowIntercomDetach && options.intercomEvents) {
					options.intercomEvents.on("pi-intercom:detach-request", (payload: any) => {
						if (payload.runId !== options.runId) return;
						clearTimeout(slowTimer);
						resolve({
							agent: "stub",
							task: "do work",
							exitCode: -2,
							detached: true,
							detachedReason: "supervisor request",
							messages: [],
							usage: fullUsage,
						});
					});
				}
			});
		});

		const ctx = {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: undefined,
			model: "test-model",
		} as unknown as ExtensionContext;

		const started = Date.now();
		const result = await registeredTool.execute(
			"call-1",
			{ agent: "stub", task: "call ask_supervisor", cwd: tempDir },
			undefined,
			undefined,
			ctx,
		);
		const elapsed = Date.now() - started;

		// The whole point: this must not take anywhere near SLOW_MS. If index.ts's
		// poller-to-emitter wiring regresses (e.g. an accidental revert), the mock
		// never sees a detach-request event and falls through to the slow timer.
		expect(elapsed).toBeLessThan(SLOW_MS - 500);

		const details = result.details as { results: Array<{ detached?: boolean }> };
		expect(details.results[0]?.detached).toBe(true);
	});
});
