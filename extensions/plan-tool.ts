/**
 * plan tool — create, edit, get, list, delete plans stored as Markdown files
 * under .pi-workflow/plans/. Available in all modes (including plan mode).
 *
 * Each plan file: .pi-workflow/plans/<id>.md
 * The id is a short slug derived from the name, made unique with a timestamp
 * suffix when a collision would occur.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Directory helpers ────────────────────────────────────────────────────

export function plansDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow", "plans");
}

function ensurePlansDir(cwd: string): string {
	const dir = plansDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ── ID / slug helpers ────────────────────────────────────────────────────

/** Converts a plan name to a filesystem-safe slug. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "plan";
}

/**
 * Returns a unique plan id for the given name. If <slug>.md already exists,
 * appends a millisecond timestamp to make it unique.
 */
export function uniquePlanId(cwd: string, name: string): string {
	const dir = plansDir(cwd);
	const base = slugify(name);
	if (!fs.existsSync(path.join(dir, `${base}.md`))) return base;
	return `${base}-${Date.now()}`;
}

// ── Plan metadata ────────────────────────────────────────────────────────

export interface PlanMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	sizeBytes: number;
}

/** Reads the first H1 heading from a markdown string as the plan name. */
function extractName(content: string, fallback: string): string {
	const match = /^#\s+(.+)$/m.exec(content);
	return match ? match[1].trim() : fallback;
}

export function readPlanMeta(dir: string, id: string): PlanMeta | null {
	const filePath = path.join(dir, `${id}.md`);
	try {
		const stat = fs.statSync(filePath);
		const content = fs.readFileSync(filePath, "utf-8");
		return {
			id,
			name: extractName(content, id),
			createdAt: stat.birthtime.toISOString(),
			updatedAt: stat.mtime.toISOString(),
			sizeBytes: stat.size,
		};
	} catch {
		return null;
	}
}

export function listAllPlans(cwd: string): PlanMeta[] {
	const dir = plansDir(cwd);
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	return files
		.map((f) => readPlanMeta(dir, f.slice(0, -3)))
		.filter((m): m is PlanMeta => m !== null)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Core actions ─────────────────────────────────────────────────────────

export type PlanActionResult =
	| { ok: true; message: string; id?: string; content?: string; plans?: PlanMeta[] }
	| { ok: false; error: string };

export function planCreate(
	cwd: string,
	name: string,
	content: string,
): PlanActionResult {
	if (!name.trim()) return { ok: false, error: "name is required." };
	if (!content.trim()) return { ok: false, error: "content is required." };
	const dir = ensurePlansDir(cwd);
	const id = uniquePlanId(cwd, name);
	const filePath = path.join(dir, `${id}.md`);
	// Ensure H1 heading is present
	const body = content.startsWith("# ") ? content : `# ${name}\n\n${content}`;
	fs.writeFileSync(filePath, body, "utf-8");
	return { ok: true, message: `Plan created: ${id}.md`, id };
}

export function planGet(cwd: string, id: string): PlanActionResult {
	const filePath = path.join(plansDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Plan "${id}" not found.` };
	const content = fs.readFileSync(filePath, "utf-8");
	return { ok: true, message: `Plan "${id}"`, id, content };
}

export function planList(cwd: string): PlanActionResult {
	const plans = listAllPlans(cwd);
	if (plans.length === 0) return { ok: true, message: "No plans yet.", plans: [] };
	return { ok: true, message: `${plans.length} plan(s).`, plans };
}

export function planEdit(
	cwd: string,
	id: string,
	oldText: string,
	newText: string,
): PlanActionResult {
	const filePath = path.join(plansDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Plan "${id}" not found.` };
	const content = fs.readFileSync(filePath, "utf-8");
	const occurrences = content.split(oldText).length - 1;
	if (occurrences === 0) return { ok: false, error: `oldText not found in plan "${id}". Check exact whitespace and content.` };
	if (occurrences > 1) return { ok: false, error: `oldText matches ${occurrences} locations in plan "${id}". Provide more context to make it unique.` };
	const updated = content.replace(oldText, newText);
	fs.writeFileSync(filePath, updated, "utf-8");
	return { ok: true, message: `Plan "${id}" updated.`, id };
}

export function planDelete(cwd: string, id: string): PlanActionResult {
	const filePath = path.join(plansDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Plan "${id}" not found.` };
	fs.unlinkSync(filePath);
	return { ok: true, message: `Plan "${id}" deleted.` };
}

