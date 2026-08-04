/**
 * Tests for the workflow tool's saveWorkflow / loadWorkflow parameters,
 * which persist and reuse workflow scripts via .pi-workflow/workflows/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createWorkflowTool } from "../extensions/workflow-tool.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { getWorkflowLibraryDir, loadSavedWorkflowScript, listSavedWorkflows } from "../extensions/workflow-library.ts";

describe("workflow tool save/load integration", () => {
	let tempDir: string;
	let manager: WorkflowManager;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-save-load-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new WorkflowManager();
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function makeTool(runSingleAgent?: any) {
		return createWorkflowTool({
			workflowManager: manager,
			runSingleAgent:
				runSingleAgent ??
				(async (_cwd: string, _agent: any, _task: string) => "agent output"),
		});
	}

	it("does not save the script by default (saveWorkflow omitted)", async () => {
		const tool = makeTool();
		const script = `export const meta = { name: "my_wf", description: "test" };\nawait agent("do a thing", { label: "step 1" });`;

		await tool.execute("call-1", { script }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		expect(fs.existsSync(getWorkflowLibraryDir(tempDir))).toBe(false);
	});

	it("saves the script to .pi-workflow/workflows/<name>.js when saveWorkflow: true", async () => {
		const tool = makeTool();
		const script = `export const meta = { name: "my_wf", description: "test" };\nawait agent("do a thing", { label: "step 1" });`;

		const result = await tool.execute("call-1", { script, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		const saved = loadSavedWorkflowScript(tempDir, "my_wf");
		expect(saved).toBeDefined();
		expect(saved).toContain('meta = { name: "my_wf"');

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Saved for reuse");
		expect(text).toContain('loadWorkflow: "my_wf"');
	});

	it("runs a previously saved workflow via loadWorkflow without a script param", async () => {
		const calls: string[] = [];
		const tool = makeTool(async (_cwd: string, _agent: any, task: string) => {
			calls.push(task);
			return "ok";
		});

		const script = `export const meta = { name: "reusable_wf", description: "test" };\nawait agent("first run task", { label: "step 1" });`;
		await tool.execute("call-1", { script, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		expect(calls).toEqual(["first run task"]);

		// Second invocation: no script at all, only loadWorkflow.
		const result = await tool.execute("call-2", { loadWorkflow: "reusable_wf" }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		expect(calls).toEqual(["first run task", "first run task"]);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("reusable_wf");
		expect(text).toContain("completed");
	});

	it("throws a helpful error when loadWorkflow references an unknown name", async () => {
		const tool = makeTool();

		await expect(
			tool.execute("call-1", { loadWorkflow: "does_not_exist" }, undefined, undefined, {
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s1" },
			} as any),
		).rejects.toThrow(/No saved workflow named "does_not_exist"/);
	});

	it("lists available saved workflows in the error when none match", async () => {
		const tool = makeTool();
		const script = `export const meta = { name: "existing_wf", description: "test" };\nawait agent("task", { label: "step 1" });`;
		await tool.execute("call-1", { script, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		await expect(
			tool.execute("call-2", { loadWorkflow: "typo_wf" }, undefined, undefined, {
				cwd: tempDir,
				sessionManager: { getSessionId: () => "s1" },
			} as any),
		).rejects.toThrow(/existing_wf/);
	});

	it("does not require a script param when loadWorkflow is provided (prepareArguments)", async () => {
		const tool = makeTool();
		const script = `export const meta = { name: "prepped_wf", description: "test" };\nawait agent("task", { label: "step 1" });`;
		await tool.execute("call-1", { script, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		// prepareArguments should not throw for a loadWorkflow-only call.
		expect(() => tool.prepareArguments?.({ loadWorkflow: "prepped_wf" })).not.toThrow();
	});

	it("throws when neither script nor loadWorkflow is provided", () => {
		const tool = makeTool();
		expect(() => tool.prepareArguments?.({})).toThrow(/requires either .script. .* or .loadWorkflow./);
	});

	it("overwriting-save does not duplicate files in the library", async () => {
		const tool = makeTool();
		const scriptV1 = `export const meta = { name: "versioned_wf", description: "v1" };\nawait agent("v1 task", { label: "step 1" });`;
		await tool.execute("call-1", { script: scriptV1, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		const scriptV2 = `export const meta = { name: "versioned_wf", description: "v2" };\nawait agent("v2 task", { label: "step 1" });`;
		await tool.execute("call-2", { script: scriptV2, saveWorkflow: true }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as any);

		const saved = listSavedWorkflows(tempDir);
		expect(saved.length).toBe(1);
		const loaded = loadSavedWorkflowScript(tempDir, "versioned_wf");
		expect(loaded).toContain("v2 task");
	});
});
