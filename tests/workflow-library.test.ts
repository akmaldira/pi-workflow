import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	saveWorkflowScript,
	loadSavedWorkflowScript,
	listSavedWorkflows,
	deleteSavedWorkflow,
	sanitizeWorkflowName,
	getWorkflowLibraryDir,
} from "../extensions/workflow-library.ts";

const SCRIPT = `export const meta = { name: 'my_workflow', description: 'does a thing' };
phase('Step 1');
await agent('scout: look around', { label: 'look around' });
return { ok: true };`;

describe("workflow-library", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-library-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("saves a workflow script to .pi-workflow/workflows/<name>.js", () => {
		const { filePath, name } = saveWorkflowScript(tempDir, SCRIPT, { name: "my_workflow", description: "does a thing" });
		expect(name).toBe("my_workflow");
		expect(filePath).toBe(path.join(getWorkflowLibraryDir(tempDir), "my_workflow.js"));
		expect(fs.existsSync(filePath)).toBe(true);
		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("export const meta = { name: 'my_workflow'");
		expect(content).toContain("Saved pi-workflow script");
	});

	it("loads a previously saved script by name", () => {
		saveWorkflowScript(tempDir, SCRIPT, { name: "my_workflow", description: "does a thing" });
		const loaded = loadSavedWorkflowScript(tempDir, "my_workflow");
		expect(loaded).toBeDefined();
		expect(loaded).toContain("meta = { name: 'my_workflow'");
		expect(loaded).toContain("await agent('scout: look around'");
	});

	it("returns undefined when loading a name that was never saved", () => {
		expect(loadSavedWorkflowScript(tempDir, "does_not_exist")).toBeUndefined();
	});

	it("overwrites a prior save with the same meta.name", () => {
		saveWorkflowScript(tempDir, SCRIPT, { name: "my_workflow", description: "v1" });
		const updated = `export const meta = { name: 'my_workflow', description: 'v2' };
await agent('scout: something else', { label: 'v2 step' });
return { ok: true, version: 2 };`;
		saveWorkflowScript(tempDir, updated, { name: "my_workflow", description: "v2" });

		const files = fs.readdirSync(getWorkflowLibraryDir(tempDir));
		expect(files.length).toBe(1);
		const loaded = loadSavedWorkflowScript(tempDir, "my_workflow");
		expect(loaded).toContain("v2 step");
		expect(loaded).not.toContain("look around");
	});

	it("lists saved workflows with parsed meta, newest first", async () => {
		const scriptA = `export const meta = { name: 'workflow_a', description: 'first one' };\nawait agent('do a');\nreturn {};`;
		saveWorkflowScript(tempDir, scriptA, { name: "workflow_a", description: "first one" });
		await new Promise((r) => setTimeout(r, 5));
		saveWorkflowScript(
			tempDir,
			`export const meta = { name: 'workflow_b', description: 'second one', whenToUse: 'when doing b things' };\nawait agent('do b');\nreturn {};`,
			{ name: "workflow_b", description: "second one", whenToUse: "when doing b things" },
		);

		const saved = listSavedWorkflows(tempDir);
		expect(saved.length).toBe(2);
		expect(saved[0].name).toBe("workflow_b");
		expect(saved[0].whenToUse).toBe("when doing b things");
		expect(saved[1].name).toBe("workflow_a");
		expect(saved.every((w) => w.filePath.endsWith(".js"))).toBe(true);
		expect(saved.every((w) => w.sizeBytes > 0)).toBe(true);
	});

	it("returns an empty list when no workflows have been saved", () => {
		expect(listSavedWorkflows(tempDir)).toEqual([]);
	});

	it("skips unparsable files when listing instead of throwing", () => {
		const dir = getWorkflowLibraryDir(tempDir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "corrupt.js"), "this is not valid js {{{");
		const scriptGood = `export const meta = { name: 'good_workflow', description: 'fine' };\nawait agent('do it');\nreturn {};`;
		saveWorkflowScript(tempDir, scriptGood, { name: "good_workflow", description: "fine" });

		const saved = listSavedWorkflows(tempDir);
		expect(saved.length).toBe(1);
		expect(saved[0].name).toBe("good_workflow");
	});

	it("deletes a saved workflow and returns true", () => {
		saveWorkflowScript(tempDir, SCRIPT, { name: "my_workflow", description: "does a thing" });
		expect(deleteSavedWorkflow(tempDir, "my_workflow")).toBe(true);
		expect(loadSavedWorkflowScript(tempDir, "my_workflow")).toBeUndefined();
	});

	it("deleting a name that doesn't exist returns false", () => {
		expect(deleteSavedWorkflow(tempDir, "nope")).toBe(false);
	});

	it("sanitizes unsafe characters in workflow names for the filename", () => {
		expect(sanitizeWorkflowName("weird name/with:slashes")).toBe("weird_name_with_slashes");
		expect(sanitizeWorkflowName("../../etc/passwd")).toBe(".._.._etc_passwd");
		expect(sanitizeWorkflowName("simple_snake_case")).toBe("simple_snake_case");
	});

	it("saving with a name containing path separators does not escape the library dir", () => {
		const { filePath } = saveWorkflowScript(tempDir, SCRIPT, { name: "../../evil", description: "x" });
		const libraryDir = getWorkflowLibraryDir(tempDir);
		expect(path.dirname(filePath)).toBe(libraryDir);
		expect(filePath.startsWith(libraryDir)).toBe(true);
	});
});
