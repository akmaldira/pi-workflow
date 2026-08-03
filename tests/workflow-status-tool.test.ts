/**
 * Tests for the workflow_status tool (extensions/index.ts) \u2014 lets the main
 * agent investigate a workflow run's status, errors, and per-agent history
 * (prompt, full result, tool-call/output history) without needing the
 * interactive /workflows TUI.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerWorkflowStatusTool, summarizeHistoryEntry } from "../extensions/index.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

function makeMockPi() {
	const tools: Record<string, any> = {};
	return {
		registerTool(tool: any) {
			tools[tool.name] = tool;
		},
		tools,
	};
}

describe("workflow_status tool", () => {
	let manager: WorkflowManager;
	let pi: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		manager = new WorkflowManager();
		pi = makeMockPi();
		registerWorkflowStatusTool(pi as any, manager);
	});

	it("registers a tool named workflow_status", () => {
		expect(pi.tools.workflow_status).toBeDefined();
		expect(pi.tools.workflow_status.name).toBe("workflow_status");
	});

	it("reports 'not found' for an unknown runId", async () => {
		const result = await pi.tools.workflow_status.execute("call-1", { runId: "does-not-exist" });
		expect(result.content[0].text).toContain("No workflow run found");
		expect(result.details.found).toBe(false);
	});

	it("returns a summary of all agents when only runId is given", async () => {
		manager.registerRun("run-1", { name: "build_app", phases: [{ title: "Phase 1" }] });
		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "backend",
			phase: "Phase 1",
			prompt: "build the backend",
			status: "running",
		});
		manager.markAgentEnd("run-1", 1, "error", undefined, "rate limit exceeded");

		const result = await pi.tools.workflow_status.execute("call-1", { runId: "run-1" });
		const text = result.content[0].text as string;
		expect(text).toContain("build_app");
		expect(text).toContain("backend");
		expect(text).toContain("ERROR: rate limit exceeded");
		expect(result.details.found).toBe(true);
	});

	it("returns full detail (prompt, result, history) when agentId is given", async () => {
		manager.registerRun("run-2", { name: "build_app", phases: [{ title: "Phase 1" }] });
		manager.markAgentStart("run-2", 0, {
			id: 1,
			label: "backend",
			phase: "Phase 1",
			prompt: "build the backend REST API",
			status: "running",
		});
		manager.recordAgentHistory("run-2", 1, {
			role: "assistant",
			kind: "toolCall",
			toolName: "bash",
			args: '{"command":"ls -la"}',
			text: "bash(ls)",
		});
		manager.recordAgentHistory("run-2", 1, {
			role: "toolResult",
			toolName: "bash",
			text: "total 60\ndrwxr-xr-x ...",
		});
		manager.markAgentEnd("run-2", 1, "done", '{"status":"ok","endpoints":3}');

		const result = await pi.tools.workflow_status.execute("call-1", { runId: "run-2", agentId: 1 });
		const text = result.content[0].text as string;
		expect(text).toContain("build the backend REST API");
		expect(text).toContain('"status":"ok"');
		expect(text).toContain("bash");
		expect(text).toContain("total 60");
		expect(result.details.found).toBe(true);
		expect(result.details.agent.id).toBe(1);
	});

	it("reports 'not found' for an unknown agentId within a known run", async () => {
		manager.registerRun("run-3", { name: "build_app" });
		manager.markAgentStart("run-3", 0, {
			id: 1,
			label: "backend",
			prompt: "build",
			status: "running",
		});

		const result = await pi.tools.workflow_status.execute("call-1", { runId: "run-3", agentId: 999 });
		expect(result.content[0].text).toContain("No agent with id 999");
		expect(result.details.found).toBe(false);
	});

	it("truncates history when it exceeds historyLimit and notes how many were omitted", async () => {
		manager.registerRun("run-4", { name: "build_app" });
		manager.markAgentStart("run-4", 0, { id: 1, label: "backend", prompt: "build", status: "running" });
		for (let i = 0; i < 10; i++) {
			manager.recordAgentHistory("run-4", 1, { role: "assistant", kind: "toolCall", toolName: "read", args: `{"i":${i}}`, text: `read(${i})` });
		}
		manager.markAgentEnd("run-4", 1, "done");

		const result = await pi.tools.workflow_status.execute("call-1", { runId: "run-4", agentId: 1, historyLimit: 3 });
		const text = result.content[0].text as string;
		expect(text).toContain("3 of 10 entries");
		expect(text).toContain("more history entries not shown");
	});
});

describe("summarizeHistoryEntry", () => {
	it("formats a toolCall entry", () => {
		const text = summarizeHistoryEntry({ role: "assistant", kind: "toolCall", toolName: "bash", args: '{"command":"ls"}' });
		expect(text).toContain("bash");
		expect(text).toContain("ls");
	});

	it("formats a toolResult entry with an error tag when isError is true", () => {
		const text = summarizeHistoryEntry({ role: "toolResult", toolName: "bash", text: "command not found", isError: true });
		expect(text).toContain("[error]");
		expect(text).toContain("command not found");
	});

	it("formats plain assistant text", () => {
		const text = summarizeHistoryEntry({ role: "assistant", text: "Here is my plan." });
		expect(text).toContain("[assistant]");
		expect(text).toContain("Here is my plan.");
	});
});
