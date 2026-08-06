/**
 * Tests for the /workflow command (extensions/workflow-mode.ts): a mode
 * toggle that forces the agent to delegate through the workflow tool by
 * restricting the active tool set (blocking write/edit/subagent, allowing
 * only read-only bash) and injecting a system-prompt directive.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, beforeEach } from "vitest";
import {
	registerWorkflowMode,
	isWriteBashCommand,
	getWorkflowModeTools,
	getRestoredTools,
	WORKFLOW_MODE_SYSTEM_DIRECTIVE,
} from "../extensions/workflow-mode.ts";

// --- Pure helper function tests -------------------------------------------

describe("isWriteBashCommand", () => {
	it("blocks common mutation commands", () => {
		expect(isWriteBashCommand("rm -rf /tmp/foo")).toBe(true);
		expect(isWriteBashCommand("mv a.txt b.txt")).toBe(true);
		expect(isWriteBashCommand("cp a.txt b.txt")).toBe(true);
		expect(isWriteBashCommand("mkdir foo")).toBe(true);
		expect(isWriteBashCommand("touch foo.txt")).toBe(true);
		expect(isWriteBashCommand("chmod +x foo.sh")).toBe(true);
		expect(isWriteBashCommand("sed -i 's/a/b/' file.txt")).toBe(true);
		expect(isWriteBashCommand("echo hi > file.txt")).toBe(true);
		expect(isWriteBashCommand("echo hi >> file.txt")).toBe(true);
		expect(isWriteBashCommand("npm install lodash")).toBe(true);
		expect(isWriteBashCommand("git commit -m 'wip'")).toBe(true);
		expect(isWriteBashCommand("git push origin main")).toBe(true);
		expect(isWriteBashCommand("git checkout -b feature")).toBe(true);
		expect(isWriteBashCommand("sudo apt install curl")).toBe(true);
		expect(isWriteBashCommand("kill -9 1234")).toBe(true);
	});

	it("allows read-only commands", () => {
		expect(isWriteBashCommand("cat file.txt")).toBe(false);
		expect(isWriteBashCommand("grep -r foo .")).toBe(false);
		expect(isWriteBashCommand("ls -la")).toBe(false);
		expect(isWriteBashCommand("git status")).toBe(false);
		expect(isWriteBashCommand("git log --oneline")).toBe(false);
		expect(isWriteBashCommand("git diff")).toBe(false);
		expect(isWriteBashCommand("npm list")).toBe(false);
		expect(isWriteBashCommand("curl https://example.com")).toBe(false);
		expect(isWriteBashCommand("find . -name '*.ts'")).toBe(false);
		expect(isWriteBashCommand("echo hello")).toBe(false);
		expect(isWriteBashCommand("wc -l file.txt")).toBe(false);
	});
});

describe("getWorkflowModeTools", () => {
	it("removes write/edit/subagent and adds the workflow-mode tool set", () => {
		const before = ["read", "write", "edit", "bash", "subagent", "workflow", "some_other_tool"];
		const result = getWorkflowModeTools(before);
		expect(result).not.toContain("write");
		expect(result).not.toContain("edit");
		expect(result).not.toContain("subagent");
		expect(result).toContain("read");
		expect(result).toContain("bash");
		expect(result).toContain("workflow");
		expect(result).toContain("workflow_status");
		expect(result).toContain("grep");
		expect(result).toContain("find");
		expect(result).toContain("ls");
		// preserves other currently-active tools untouched
		expect(result).toContain("some_other_tool");
	});

	it("de-duplicates tool names", () => {
		const before = ["read", "bash", "workflow"];
		const result = getWorkflowModeTools(before);
		expect(result.filter((t) => t === "read").length).toBe(1);
		expect(result.filter((t) => t === "bash").length).toBe(1);
		expect(result.filter((t) => t === "workflow").length).toBe(1);
	});
});

describe("getRestoredTools", () => {
	it("restores the exact snapshot taken before entering workflow mode", () => {
		const before = ["read", "write", "edit", "bash", "subagent", "workflow", "my_tool"];
		const restored = getRestoredTools(["read", "bash", "workflow", "grep", "find", "ls"], before);
		expect(restored).toEqual(before);
	});

	it("falls back to re-adding disabled tools when no snapshot exists", () => {
		const restored = getRestoredTools(["read", "bash", "workflow", "grep", "find", "ls"], undefined);
		expect(restored).toContain("write");
		expect(restored).toContain("edit");
		expect(restored).toContain("subagent");
		expect(restored).toContain("read");
		expect(restored).toContain("bash");
	});
});

// --- registerWorkflowMode() integration tests using a mock pi -------------

interface MockCommandHandler {
	description: string;
	handler: (args: string, ctx: ReturnType<typeof makeMockCtx>) => Promise<void>;
}

interface ToolCallBlockResult {
	block: true;
	reason: string;
}

interface SystemPromptResult {
	systemPrompt: string;
}

function makeMockPi() {
	const commands: Record<string, MockCommandHandler> = {};
	const toolCallHandlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<ToolCallBlockResult | undefined>> = [];
	const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }) => Promise<SystemPromptResult | undefined>> = [];
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "workflow", "workflow_status"];

	const mock = {
		commands,
		registerCommand(name: string, opts: MockCommandHandler) {
			commands[name] = opts;
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (event === "tool_call") toolCallHandlers.push(handler as typeof toolCallHandlers[number]);
			if (event === "before_agent_start") beforeAgentStartHandlers.push(handler as typeof beforeAgentStartHandlers[number]);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(tools: string[]) {
			activeTools = [...tools];
		},
		get activeTools() {
			return activeTools;
		},
		async fireToolCall(event: { toolName: string; input: Record<string, unknown> }) {
			for (const h of toolCallHandlers) {
				const result = await h(event);
				if (result) return result;
			}
			return undefined;
		},
		async fireBeforeAgentStart(event: { systemPrompt: string }) {
			for (const h of beforeAgentStartHandlers) {
				const result = await h(event);
				if (result) return result;
			}
			return undefined;
		},
	};
	return mock;
}

/** Cast the minimal mock harness to ExtensionAPI once at the call boundary
 * (registerWorkflowMode only calls .on/.registerCommand/.getActiveTools/.setActiveTools
 * on it — the mock covers exactly that surface). */
function asExtensionAPI(mock: ReturnType<typeof makeMockPi>): ExtensionAPI {
	return mock as unknown as ExtensionAPI;
}

function makeMockCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Record<string, string | undefined> = {};
	return {
		notifications,
		statuses,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses[key] = value;
			},
			theme: { fg: (_name: string, text: string) => text },
		},
	};
}

describe("registerWorkflowMode", () => {
	let pi: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		pi = makeMockPi();
	});

	it("registers a /workflow command", () => {
		registerWorkflowMode(asExtensionAPI(pi));
		expect(pi.commands.workflow).toBeDefined();
	});

	it("/workflow on restricts active tools (removes write/edit/subagent)", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		expect(pi.activeTools).not.toContain("write");
		expect(pi.activeTools).not.toContain("edit");
		expect(pi.activeTools).not.toContain("subagent");
		expect(pi.activeTools).toContain("workflow");
		expect(pi.activeTools).toContain("bash");
		expect(pi.activeTools).toContain("read");
		expect(ctx.notifications[0].message).toContain("ON");
	});

	it("/workflow off restores the full tool set", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		const before = pi.activeTools;

		await pi.commands.workflow.handler("on", ctx);
		expect(pi.activeTools).not.toContain("write");

		await pi.commands.workflow.handler("off", ctx);
		expect(pi.activeTools.sort()).toEqual(before.sort());
		expect(ctx.notifications[1].message).toContain("OFF");
	});

	it("/workflow with no args or 'status' reports current state without changing tools", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		const before = pi.activeTools;

		await pi.commands.workflow.handler("", ctx);
		expect(ctx.notifications[0].message).toContain("OFF");
		expect(pi.activeTools).toEqual(before);

		await pi.commands.workflow.handler("on", ctx);
		await pi.commands.workflow.handler("status", ctx);
		expect(ctx.notifications[2].message).toContain("ON");
	});

	it("/workflow with an unknown argument warns and does not change mode", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("banana", ctx);
		expect(ctx.notifications[0].type).toBe("warning");
	});

	it("blocks the write tool call while workflow mode is on", async () => {
		const state = registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);
		expect(state.enabled).toBe(true);

		const result = await pi.fireToolCall({ toolName: "write", input: { path: "foo.txt", content: "x" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("workflow");
	});

	it("blocks the edit tool call while workflow mode is on", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		const result = await pi.fireToolCall({ toolName: "edit", input: { path: "foo.txt", edits: [] } });
		expect(result?.block).toBe(true);
	});

	it("blocks the subagent tool call while workflow mode is on", async () => {
		registerWorkflowMode(asExtensionAPI(pi), { subagentToolName: "subagent" });
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		const result = await pi.fireToolCall({ toolName: "subagent", input: { agent: "worker", task: "do stuff" } });
		expect(result?.block).toBe(true);
	});

	it("does NOT block write/edit/subagent when workflow mode is off", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const result = await pi.fireToolCall({ toolName: "write", input: { path: "foo.txt", content: "x" } });
		expect(result).toBeUndefined();
	});

	it("blocks write-shaped bash commands while workflow mode is on", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		const result = await pi.fireToolCall({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("read-only");
	});

	it("allows read-only bash commands while workflow mode is on", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		const result = await pi.fireToolCall({ toolName: "bash", input: { command: "git status" } });
		expect(result).toBeUndefined();
	});

	it("injects the workflow-mode system-prompt directive when on", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		await pi.commands.workflow.handler("on", ctx);

		const result = await pi.fireBeforeAgentStart({ systemPrompt: "Base system prompt." });
		expect(result?.systemPrompt).toContain("Base system prompt.");
		expect(result?.systemPrompt).toContain(WORKFLOW_MODE_SYSTEM_DIRECTIVE);
	});

	it("does not inject the directive when workflow mode is off", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const result = await pi.fireBeforeAgentStart({ systemPrompt: "Base system prompt." });
		expect(result).toBeUndefined();
	});

	it("toggling on then off then on again restricts tools correctly each time (idempotent snapshotting)", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		const original = pi.activeTools;

		await pi.commands.workflow.handler("on", ctx);
		await pi.commands.workflow.handler("off", ctx);
		expect(pi.activeTools.sort()).toEqual(original.sort());

		await pi.commands.workflow.handler("on", ctx);
		expect(pi.activeTools).not.toContain("write");
		await pi.commands.workflow.handler("off", ctx);
		expect(pi.activeTools.sort()).toEqual(original.sort());
	});
});
