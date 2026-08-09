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
});
