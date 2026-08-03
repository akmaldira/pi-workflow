import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

describe("WorkflowManager", () => {
	let tempDir: string;
	let manager: WorkflowManager;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-mgr-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new WorkflowManager(tempDir);
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers active run and emits agentStart event", () => {
		let eventFired = false;
		manager.on("agentStart", () => {
			eventFired = true;
		});

		const run = manager.registerRun("run-1", { name: "test_workflow", description: "test" });

		expect(run.runId).toBe("run-1");
		expect(run.status).toBe("running");
		expect(eventFired).toBe(true);
		expect(manager.getRun("run-1")).toBe(run);
	});

	it("tracks phase transitions", () => {
		manager.registerRun("run-1", {
			name: "test",
			phases: [{ title: "Phase 1" }, { title: "Phase 2" }],
		});

		manager.markPhase("run-1", 0, "Phase 1");
		const run = manager.getRun("run-1");
		expect(run?.snapshot.phases[0].status).toBe("active");
	});

	it("tracks agent progress and completion", () => {
		manager.registerRun("run-1", { name: "test" });

		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
		});

		const run = manager.getRun("run-1");
		expect(run?.snapshot.agents.length).toBe(1);

		manager.markAgentEnd("run-1", 1, "done", "result ok", undefined, 150, 1000);

		expect(run?.snapshot.agents[0].status).toBe("done");
		expect(run?.snapshot.agents[0].outputTokens).toBe(150);
		expect(run?.snapshot.totalTokens).toBe(150);
	});

	it("completes run with success", () => {
		let completed = false;
		manager.on("complete", () => {
			completed = true;
		});

		manager.registerRun("run-1", { name: "test" });
		manager.completeRun("run-1", { success: true });

		const run = manager.getRun("run-1");
		expect(run?.status).toBe("completed");
		expect(run?.snapshot.status).toBe("completed");
		expect(completed).toBe(true);
	});

	it("completes run with error", () => {
		let errored = false;
		manager.on("error", () => {
			errored = true;
		});

		manager.registerRun("run-1", { name: "test" });
		manager.completeRun("run-1", undefined, "Failed execution");

		const run = manager.getRun("run-1");
		expect(run?.status).toBe("error");
		expect(run?.snapshot.status).toBe("error");
		expect(errored).toBe(true);
	});

	it("watches transcript JSONL file and emits history entries", async () => {
		const transcriptPath = path.join(tempDir, "transcript.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

		manager.registerRun("run-1", { name: "test" });

		let historyEmitted = false;
		manager.on("agentHistory", (evt) => {
			if (evt.agentId === 1) historyEmitted = true;
		});

		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		// Write transcript records
		const record1 = {
			version: 1,
			recordType: "tool_start",
			toolName: "bash",
			argsPreview: "echo hello",
			ts: Date.now(),
		};
		const record2 = {
			version: 1,
			recordType: "message",
			role: "assistant",
			text: "I ran the command",
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record1)}\n${JSON.stringify(record2)}\n`);

		// Wait for poll interval
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-1");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history).toBeDefined();
		expect(agent?.history?.length).toBeGreaterThanOrEqual(2);
		expect(agent?.history?.[0].toolName).toBe("bash");
		expect(agent?.history?.[1].text).toBe("I ran the command");
		expect(historyEmitted).toBe(true);

		manager.markAgentEnd("run-1", 1, "done");
	});

	it("records toolCall entries with args populated (not undefined)", async () => {
		const transcriptPath = path.join(tempDir, "transcript-args.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-args", { name: "test" });
		manager.markAgentStart("run-args", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const record = {
			version: 1,
			recordType: "tool_start",
			toolName: "read",
			argsPreview: '{"path":"foo.ts"}',
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-args");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		const entry = agent?.history?.[0];
		expect(entry).toBeDefined();
		expect(entry?.role).toBe("assistant");
		if (entry?.role === "assistant" && entry.kind === "toolCall") {
			expect(entry.args).toBe('{"path":"foo.ts"}');
			expect(entry.toolName).toBe("read");
		} else {
			throw new Error("expected toolCall entry");
		}

		manager.markAgentEnd("run-args", 1, "done");
	});

	it("records toolResult entries with actual text (not '[]')", async () => {
		const transcriptPath = path.join(tempDir, "transcript-result.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-result", { name: "test" });
		manager.markAgentStart("run-result", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		// This simulates what child-transcript.ts now correctly writes after the
		// extractTextFromContent(message) fix — real file contents, not "[]".
		const record = {
			version: 1,
			recordType: "message",
			role: "toolResult",
			toolName: "read",
			text: "export function foo() {}",
			isError: false,
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-result");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		const entry = agent?.history?.[0];
		expect(entry).toBeDefined();
		expect(entry?.role).toBe("toolResult");
		expect(entry?.text).toBe("export function foo() {}");
		expect(entry?.text).not.toBe("[]");

		manager.markAgentEnd("run-result", 1, "done");
	});

	it("records assistant text messages (not just tool calls)", async () => {
		const transcriptPath = path.join(tempDir, "transcript-text.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-text", { name: "test" });
		manager.markAgentStart("run-text", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const toolRecord = { version: 1, recordType: "tool_start", toolName: "bash", argsPreview: "ls", ts: Date.now() };
		const textRecord = { version: 1, recordType: "message", role: "assistant", text: "Here is my plan for the task.", ts: Date.now() };
		fs.writeFileSync(transcriptPath, `${JSON.stringify(toolRecord)}\n${JSON.stringify(textRecord)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-text");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history?.length).toBe(2);
		const textEntry = agent?.history?.find((e) => e.role === "assistant" && "kind" in e && e.kind === "text");
		expect(textEntry).toBeDefined();
		expect(textEntry?.text).toBe("Here is my plan for the task.");

		manager.markAgentEnd("run-text", 1, "done");
	});

	it("does not record duplicate entries for the same transcript line", async () => {
		const transcriptPath = path.join(tempDir, "transcript-dedup.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-dedup", { name: "test" });
		manager.markAgentStart("run-dedup", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const record = { version: 1, recordType: "tool_start", toolName: "bash", argsPreview: "echo hi", ts: Date.now() };
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);

		// Wait through multiple poll cycles — the byte offset tracking should
		// prevent re-reading the same line more than once.
		await new Promise((r) => setTimeout(r, 700));

		const run = manager.getRun("run-dedup");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history?.length).toBe(1);

		manager.markAgentEnd("run-dedup", 1, "done");
	});

	it("pauses, resumes, and stops active run", () => {
		const abortController = new AbortController();
		manager.registerRun("run-1", { name: "test" }, abortController);

		expect(manager.pauseRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("paused");

		expect(manager.resumeRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("running");

		expect(manager.stopRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("stopped");
		expect(abortController.signal.aborted).toBe(true);
	});

	it("lists both active and persisted runs from journal directory", () => {
		manager.registerRun("run-active", { name: "active_wf" });

		// Create a mock journal file
		const journalPath = path.join(tempDir, "run-persisted.jsonl");
		fs.writeFileSync(
			journalPath,
			JSON.stringify({ type: "run", name: "persisted_wf" }) +
				"\n" +
				JSON.stringify({ type: "agent", seq: 1, label: "Agent P1", outputTokens: 200 }),
		);

		const runs = manager.listRuns();
		expect(runs.length).toBe(2);

		const names = runs.map((r) => r.workflowName);
		expect(names).toContain("active_wf");
		expect(names).toContain("persisted_wf");
	});

	it("updates WorkflowManager events when workflow tool executes", async () => {
		const { createWorkflowTool } = await import("../extensions/workflow-tool.ts");
		const tool = createWorkflowTool({
			workflowManager: manager,
			runSingleAgent: async () => "agent output",
		});

		const script = `
			export const meta = { name: "integration_test", description: "test" };
			phase("Phase 1");
			await agent("test agent", { label: "agent 1" });
		`;

		await tool.execute("call-1", { script }, undefined, undefined, { cwd: tempDir, sessionManager: { getSessionId: () => "s1" } } as any);

		const runs = manager.listRuns();
		expect(runs.length).toBe(1);
		expect(runs[0].workflowName).toBe("integration_test");
		expect(runs[0].status).toBe("completed");
		expect(runs[0].agents.length).toBe(1);
		expect(runs[0].agents[0].label).toBe("agent 1");
		expect(runs[0].agents[0].status).toBe("done");
	});
});
