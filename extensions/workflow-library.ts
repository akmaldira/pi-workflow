/**
 * Saved workflow library — persists workflow scripts to
 * `.pi-workflow/workflows/<name>.js` so they can be listed and re-run later
 * via the `workflow` tool's `loadWorkflow` parameter, without the agent (or
 * user) having to re-author the script from scratch each time.
 *
 * One file per `meta.name`; saving again with the same name overwrites the
 * previous version (no history/versioning — keep it simple).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkflowScript, type WorkflowMeta } from "./workflow.ts";

export interface SavedWorkflowInfo {
	/** meta.name of the saved workflow (also the filename stem) */
	name: string;
	description: string;
	whenToUse?: string;
	filePath: string;
	savedAt: number;
	sizeBytes: number;
}

export function getWorkflowLibraryDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow", "workflows");
}

/**
 * Turn a workflow name into a safe filename stem. meta.name is already
 * expected to be short_snake_case by convention, but sanitize defensively
 * in case the script used something unexpected.
 */
export function sanitizeWorkflowName(name: string): string {
	const safe = name.trim().replace(/[^\w.-]+/g, "_");
	return safe || "workflow";
}

function getWorkflowFilePath(cwd: string, name: string): string {
	return path.join(getWorkflowLibraryDir(cwd), `${sanitizeWorkflowName(name)}.js`);
}

/**
 * Save a workflow script to the project-local library, keyed by
 * `meta.name`. Overwrites any prior version saved under the same name.
 * Returns the path the script was written to.
 */
export function saveWorkflowScript(cwd: string, script: string, meta: WorkflowMeta): { filePath: string; name: string } {
	const dir = getWorkflowLibraryDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const name = sanitizeWorkflowName(meta.name);
	const filePath = getWorkflowFilePath(cwd, name);

	const header = [
		"/**",
		" * Saved pi-workflow script \u2014 reusable via the `workflow` tool's",
		` * loadWorkflow: "${name}" parameter (no need to pass \`script\` again).`,
		` * Name: ${meta.name}`,
		` * Description: ${meta.description}`,
		meta.whenToUse ? ` * When to use: ${meta.whenToUse}` : undefined,
		` * Saved: ${new Date().toISOString()}`,
		" */",
	].filter((l): l is string => l !== undefined);

	const content = `${header.join("\n")}\n${script.trim()}\n`;
	fs.writeFileSync(filePath, content, "utf-8");
	return { filePath, name };
}

/**
 * Load a previously saved workflow script by name. Returns undefined if not
 * found (caller should list available names for a helpful error message).
 */
export function loadSavedWorkflowScript(cwd: string, name: string): string | undefined {
	const filePath = getWorkflowFilePath(cwd, name);
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * List all workflows saved in the project-local library, parsing each
 * file's `meta` so callers get name/description/whenToUse without having to
 * re-parse themselves. Corrupt/unparsable files are skipped silently.
 */
export function listSavedWorkflows(cwd: string): SavedWorkflowInfo[] {
	const dir = getWorkflowLibraryDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const results: SavedWorkflowInfo[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { meta } = parseWorkflowScript(content);
			const stat = fs.statSync(filePath);
			results.push({
				name: meta.name,
				description: meta.description,
				whenToUse: meta.whenToUse,
				filePath,
				savedAt: stat.mtimeMs,
				sizeBytes: stat.size,
			});
		} catch {
			// Skip files that fail to parse (e.g. hand-edited, corrupted).
		}
	}

	return results.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Delete a saved workflow by name. Returns true if a file was removed.
 */
export function deleteSavedWorkflow(cwd: string, name: string): boolean {
	const filePath = getWorkflowFilePath(cwd, name);
	if (!fs.existsSync(filePath)) return false;
	fs.unlinkSync(filePath);
	return true;
}
