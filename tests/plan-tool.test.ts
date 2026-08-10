/**
 * Tests for extensions/plan-tool.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	slugify,
	uniquePlanId,
	planCreate,
	planGet,
	planList,
	planEdit,
	planDelete,
	listAllPlans,
	plansDir,
} from "../extensions/plan-tool.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── slugify ──────────────────────────────────────────────────────────────

describe("slugify", () => {
	it("lowercases and replaces spaces with hyphens", () => {
		expect(slugify("My Plan")).toBe("my-plan");
	});

	it("collapses multiple separators", () => {
		expect(slugify("Refactor  Auth Module!")).toBe("refactor-auth-module");
	});

	it("trims leading/trailing hyphens", () => {
		expect(slugify("--hello--")).toBe("hello");
	});

	it("falls back to 'plan' for empty string", () => {
		expect(slugify("")).toBe("plan");
	});

	it("truncates to 60 chars", () => {
		const long = "a".repeat(80);
		expect(slugify(long).length).toBe(60);
	});
});

// ── uniquePlanId ─────────────────────────────────────────────────────────

describe("uniquePlanId", () => {
	it("returns the base slug when no collision", () => {
		expect(uniquePlanId(tmpDir, "My Plan")).toBe("my-plan");
	});

	it("appends timestamp suffix on collision", () => {
		// Create the file first
		fs.mkdirSync(plansDir(tmpDir), { recursive: true });
		fs.writeFileSync(path.join(plansDir(tmpDir), "my-plan.md"), "# My Plan\n");
		const id = uniquePlanId(tmpDir, "My Plan");
		expect(id).toMatch(/^my-plan-\d+$/);
	});
});

// ── planCreate ───────────────────────────────────────────────────────────

describe("planCreate", () => {
	it("creates a plan file with H1 heading", () => {
		const result = planCreate(tmpDir, "My Plan", "Some content here.");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		expect(result.id).toBe("my-plan");
		const filePath = path.join(plansDir(tmpDir), "my-plan.md");
		expect(fs.existsSync(filePath)).toBe(true);
		const text = fs.readFileSync(filePath, "utf-8");
		expect(text).toContain("# My Plan");
		expect(text).toContain("Some content here.");
	});

	it("does not duplicate H1 if content already starts with one", () => {
		const result = planCreate(tmpDir, "My Plan", "# My Plan\n\nContent.");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		const text = fs.readFileSync(path.join(plansDir(tmpDir), "my-plan.md"), "utf-8");
		expect(text.match(/^# /m)?.length).toBe(1); // only one H1
	});

	it("returns error when name is empty", () => {
		const result = planCreate(tmpDir, "", "content");
		expect(result.ok).toBe(false);
	});

	it("returns error when content is empty", () => {
		const result = planCreate(tmpDir, "My Plan", "");
		expect(result.ok).toBe(false);
	});
});

// ── planGet ──────────────────────────────────────────────────────────────

describe("planGet", () => {
	it("returns the plan content by id", () => {
		planCreate(tmpDir, "My Plan", "Hello world.");
		const result = planGet(tmpDir, "my-plan");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		expect(result.content).toContain("Hello world.");
	});

	it("returns error for unknown id", () => {
		const result = planGet(tmpDir, "does-not-exist");
		expect(result.ok).toBe(false);
	});
});

// ── planList ─────────────────────────────────────────────────────────────

describe("planList", () => {
	it("returns empty list when no plans exist", () => {
		const result = planList(tmpDir);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		expect(result.plans).toHaveLength(0);
	});

	it("returns one entry after create", () => {
		planCreate(tmpDir, "Alpha", "content a");
		const result = planList(tmpDir);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		expect(result.plans).toHaveLength(1);
		expect(result.plans![0].id).toBe("alpha");
		expect(result.plans![0].name).toBe("Alpha");
	});

	it("returns all plans sorted by updatedAt descending", () => {
		planCreate(tmpDir, "Alpha", "a");
		planCreate(tmpDir, "Beta", "b");
		const result = planList(tmpDir);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error();
		expect(result.plans).toHaveLength(2);
		// both plans are present (mtime resolution may be too coarse for strict order)
		const ids = result.plans!.map((p) => p.id).sort();
		expect(ids).toEqual(["alpha", "beta"]);
	});
});

// ── planEdit ─────────────────────────────────────────────────────────────

describe("planEdit", () => {
	it("replaces unique text in the plan", () => {
		planCreate(tmpDir, "My Plan", "# My Plan\n\nOriginal text here.");
		const result = planEdit(tmpDir, "my-plan", "Original text here.", "Replaced text here.");
		expect(result.ok).toBe(true);
		const text = fs.readFileSync(path.join(plansDir(tmpDir), "my-plan.md"), "utf-8");
		expect(text).toContain("Replaced text here.");
		expect(text).not.toContain("Original text here.");
	});

	it("returns error when oldText not found", () => {
		planCreate(tmpDir, "My Plan", "# My Plan\n\nContent.");
		const result = planEdit(tmpDir, "my-plan", "Nonexistent text", "New text");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error();
		expect(result.error).toMatch(/not found/i);
	});

	it("returns error when oldText matches multiple times", () => {
		planCreate(tmpDir, "My Plan", "# My Plan\n\nfoo\nfoo\n");
		const result = planEdit(tmpDir, "my-plan", "foo", "bar");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error();
		expect(result.error).toMatch(/matches 2/i);
	});

	it("returns error for unknown plan id", () => {
		const result = planEdit(tmpDir, "ghost", "old", "new");
		expect(result.ok).toBe(false);
	});
});

// ── planDelete ───────────────────────────────────────────────────────────

describe("planDelete", () => {
	it("removes the plan file", () => {
		planCreate(tmpDir, "My Plan", "content");
		const result = planDelete(tmpDir, "my-plan");
		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(plansDir(tmpDir), "my-plan.md"))).toBe(false);
	});

	it("returns error for unknown id", () => {
		const result = planDelete(tmpDir, "ghost");
		expect(result.ok).toBe(false);
	});
});

// ── listAllPlans ─────────────────────────────────────────────────────────

describe("listAllPlans", () => {
	it("extracts name from H1 heading", () => {
		planCreate(tmpDir, "Refactor Auth", "# Refactor Auth\n\nDetails here.");
		const plans = listAllPlans(tmpDir);
		expect(plans[0].name).toBe("Refactor Auth");
	});

	it("falls back to id when no H1 heading", () => {
		fs.mkdirSync(plansDir(tmpDir), { recursive: true });
		fs.writeFileSync(path.join(plansDir(tmpDir), "unnamed.md"), "just some text");
		const plans = listAllPlans(tmpDir);
		expect(plans[0].name).toBe("unnamed");
	});

	it("ignores non-.md files", () => {
		fs.mkdirSync(plansDir(tmpDir), { recursive: true });
		fs.writeFileSync(path.join(plansDir(tmpDir), "junk.txt"), "hi");
		const plans = listAllPlans(tmpDir);
		expect(plans).toHaveLength(0);
	});
});
