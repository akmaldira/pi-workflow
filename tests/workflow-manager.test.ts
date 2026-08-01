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
});
