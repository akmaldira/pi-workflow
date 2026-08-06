/**
 * Tests for the /workflows TUI navigator's "save workflow" feature
 * (the 's' key), which persists a live run's script to
 * .pi-workflow/workflows/<name>.js via workflow-library.ts, reusing the
 * same in-memory script/cwd stashed on ManagedRun by
 * WorkflowManager.registerRun().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { keyToAction, saveRunWorkflow } from "../extensions/workflow-ui.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { loadSavedWorkflowScript } from "../extensions/workflow-library.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

function fakeUi(): ExtensionUIContext & { notifications: Array<{ message: string; type?: string }> } {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		notifications,
		notify: (message: string, type?: string) => {
			notifications.push({ message, type });
		},
	} as unknown as ExtensionUIContext & { notifications: Array<{ message: string; type?: string }> };
}

describe("workflow-ui: save keybinding", () => {
	it("'s' maps to a save action from the runs view", () => {
		expect(keyToAction("s", "runs")).toEqual({ type: "save" });
	});

	it("'s' maps to a save action from the detail view", () => {
		expect(keyToAction("s", "detail")).toEqual({ type: "save" });
	});

	it("'s' maps to a save action from the phases/agents views too", () => {
		expect(keyToAction("s", "phases")).toEqual({ type: "save" });
		expect(keyToAction("s", "agents")).toEqual({ type: "save" });
	});
});

describe("saveRunWorkflow", () => {
	let tempDir: string;
	let manager: WorkflowManager;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-ui-save-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new WorkflowManager();
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("saves a live run's script and notifies the user", async () => {
		const script = `export const meta = { name: "ui_saved_wf", description: "saved from TUI" };\nawait agent("do something", { label: "step 1" });`;
		manager.registerRun("run-1", { name: "ui_saved_wf", description: "saved from TUI" }, undefined, { script, cwd: tempDir });

		const ui = fakeUi();
		await saveRunWorkflow(manager, "run-1", ui);

		const loaded = loadSavedWorkflowScript(tempDir, "ui_saved_wf");
		expect(loaded).toBeDefined();
		expect(loaded).toContain('meta = { name: "ui_saved_wf"');
		expect(ui.notifications.length).toBe(1);
		expect(ui.notifications[0].message).toContain("ui_saved_wf");
		expect(ui.notifications[0].message).toContain("loadWorkflow");
		expect(ui.notifications[0].type).toBe("info");
	});

	it("notifies a warning when the run's script is not available in memory (e.g. persisted-only run)", async () => {
		// Register without source info \u2014 simulates a run whose script was
		// never attached, or one restored purely from a persisted journal.
		manager.registerRun("run-1", { name: "no_source_wf", description: "test" });

		const ui = fakeUi();
		await saveRunWorkflow(manager, "run-1", ui);

		expect(ui.notifications.length).toBe(1);
		expect(ui.notifications[0].type).toBe("warning");
		expect(ui.notifications[0].message).toMatch(/script is no longer available|not/i);
	});

	it("notifies a warning for a completely unknown runId", async () => {
		const ui = fakeUi();
		await saveRunWorkflow(manager, "does-not-exist", ui);

		expect(ui.notifications.length).toBe(1);
		expect(ui.notifications[0].type).toBe("warning");
	});

	it("does not throw and reports an error notification on write failure", async () => {
		const script = `export const meta = { name: "broken_wf", description: "test" };\nawait agent("x", { label: "step" });`;
		// Point cwd at a path that can't have a directory created under it
		// (a file, not a directory) to force saveWorkflowScript to throw.
		const blockerFile = path.join(tempDir, "blocker");
		fs.writeFileSync(blockerFile, "x");
		manager.registerRun("run-1", { name: "broken_wf", description: "test" }, undefined, { script, cwd: blockerFile });

		const ui = fakeUi();
		await expect(saveRunWorkflow(manager, "run-1", ui)).resolves.toBeUndefined();
		expect(ui.notifications.length).toBe(1);
		expect(ui.notifications[0].type).toBe("error");
	});
});
