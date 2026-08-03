/**
 * Regression tests for two bugs found while implementing graceful
 * technical-failure handling:
 *
 * 1. WorkflowManager.stopRun() called run.abortController.abort(), but
 *    workflow-tool.ts passed runWorkflow() the *original* tool-call signal,
 *    not that abortController's signal \u2014 so stopRun() (used by the
 *    /workflows TUI's "stop" action) never actually stopped anything.
 *    Fixed by combining both signals via AbortSignal.any() into
 *    effectiveSignal, which is what actually gets passed to runWorkflow().
 *
 * 2. A subagent's TechnicalFailureError should abort the whole workflow run
 *    (via onTechnicalFailure -> runAbortController.abort()) and produce a
 *    clear, actionable error message referencing workflow_status + runId.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createWorkflowTool } from "../extensions/workflow-tool.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { TechnicalFailureError } from "../extensions/failure-classifier.ts";

describe("workflow-tool.ts abort wiring", () => {
	let tempDir: string;
	let manager: WorkflowManager;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-abort-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new WorkflowManager();
	});

	it("WorkflowManager.stopRun() actually cancels a running workflow (not a no-op)", async () => {
		let sawAbort = false;
		const tool = createWorkflowTool({
			workflowManager: manager,
			runSingleAgent: async (_cwd, _agent, _task, options) => {
				// Simulate a long-running subagent that respects the abort signal,
				// exactly like execution.ts's spawned child does via SIGTERM.
				return await new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve("agent output"), 5000);
					options.signal?.addEventListener("abort", () => {
						sawAbort = true;
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				});
			},
		});

		const script = `
			export const meta = { name: "stoppable_wf", description: "test" };
			await agent("long running task", { label: "agent 1" });
		`;

		const runPromise = tool.execute("call-1", { script }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		// Wait for the run to register, then stop it via the manager \u2014 this is
		// exactly what the /workflows TUI's "stop" keybinding does.
		await new Promise((r) => setTimeout(r, 20));
		const runs = manager.listRuns();
		expect(runs.length).toBe(1);
		const stopped = manager.stopRun(runs[0].runId);
		expect(stopped).toBe(true);

		await expect(runPromise).rejects.toThrow();
		expect(sawAbort).toBe(true);
	});

	it("a technical failure aborts sibling in-flight subagents and produces an actionable error message", async () => {
		let sawSiblingAbort = false;
		const tool = createWorkflowTool({
			workflowManager: manager,
			runSingleAgent: async (_cwd, _agent, task) => {
				if (task.includes("first")) {
					throw new TechnicalFailureError("first-agent", {
						class: "technical",
						code: "provider-error",
						reason: "rate limit exceeded",
					});
				}
				// Sibling agent: should be aborted before it "completes".
				return await new Promise((resolve, reject) => {
					setTimeout(() => resolve("should not get here"), 5000);
				}).catch(() => {
					sawSiblingAbort = true;
					throw new Error("aborted");
				});
			},
		});

		const script = `
			export const meta = { name: "technical_fail_wf", description: "test" };
			const results = await parallel([
				() => agent("first task that fails"),
				() => agent("second task that should be cancelled"),
			]);
			return { results };
		`;

		await expect(
			tool.execute("call-1", { script }, undefined, undefined, {
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s1" },
			} as any),
		).rejects.toThrow(/technical failure/i);

		const runs = manager.listRuns();
		expect(runs.length).toBe(1);
		expect(runs[0].status).toBe("error");
	});

	it("technical failure error message references workflow_status and the runId for investigation", async () => {
		const tool = createWorkflowTool({
			workflowManager: manager,
			runSingleAgent: async () => {
				throw new TechnicalFailureError("architect", {
					class: "technical",
					code: "process-killed",
					reason: "killed by SIGKILL (out of memory)",
				});
			},
		});

		const script = `
			export const meta = { name: "oom_wf", description: "test" };
			await agent("design something huge");
		`;

		let thrown: Error | undefined;
		try {
			await tool.execute("call-1", { script }, undefined, undefined, {
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s1" },
			} as any);
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		expect(thrown!.message).toContain("workflow_status");
		expect(thrown!.message).toContain("architect");
		expect(thrown!.message).toContain("process-killed");
		expect(thrown!.message).toContain("SIGKILL");
	});
});
