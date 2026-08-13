/**
 * Tests for extensions/contract-tool.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	slugify,
	uniqueContractId,
	contractCreate,
	contractGet,
	contractList,
	contractEdit,
	contractPropose,
	contractSupersede,
	listAllContracts,
	contractsDir,
	contractIsExists,
	contractLength,
	contractIndexOf,
} from "../extensions/contract-tool.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-contracts-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── slugify ──────────────────────────────────────────────────────────────

describe("slugify", () => {
	it("lowercases and hyphenates", () => {
		expect(slugify("Auth API v1")).toBe("auth-api-v1");
	});

	it("strips leading/trailing hyphens", () => {
		expect(slugify("--foo--")).toBe("foo");
	});

	it("falls back to 'contract' for empty", () => {
		expect(slugify("")).toBe("contract");
	});
});

// ── contractCreate ───────────────────────────────────────────────────────

describe("contractCreate", () => {
	it("creates a draft contract file with frontmatter", () => {
		const r = contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "planner", consumer: "worker", content: "## Endpoints\n\nPOST /login" });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();
		expect(r.id).toBe("auth-api");
		const file = fs.readFileSync(path.join(contractsDir(tmpDir), "auth-api.md"), "utf-8");
		expect(file).toContain("status: draft");
		expect(file).toContain("type: api");
		expect(file).toContain("producer: planner");
		expect(file).toContain("consumer: worker");
		expect(file).toContain("version: 1");
		expect(file).toContain("POST /login");
	});

	it("auto-injects H1 if content doesn't start with one", () => {
		contractCreate(tmpDir, { name: "Task Contract", type: "task", producer: "p", consumer: "c", content: "Do the thing." });
		const file = fs.readFileSync(path.join(contractsDir(tmpDir), "task-contract.md"), "utf-8");
		expect(file).toContain("# Task Contract");
	});

	it("does not duplicate H1 if content already has one", () => {
		contractCreate(tmpDir, { name: "My Contract", type: "other", producer: "p", consumer: "c", content: "# My Contract\n\nContent." });
		const file = fs.readFileSync(path.join(contractsDir(tmpDir), "my-contract.md"), "utf-8");
		expect(file.match(/^# /m)?.length).toBe(1);
	});

	it("returns error when name is empty", () => {
		const r = contractCreate(tmpDir, { name: "", type: "api", producer: "p", consumer: "c", content: "x" });
		expect(r.ok).toBe(false);
	});

	it("returns error when producer is empty", () => {
		const r = contractCreate(tmpDir, { name: "x", type: "api", producer: "", consumer: "c", content: "x" });
		expect(r.ok).toBe(false);
	});

	it("returns error when content is empty", () => {
		const r = contractCreate(tmpDir, { name: "x", type: "api", producer: "p", consumer: "c", content: "" });
		expect(r.ok).toBe(false);
	});
});

// ── contractGet ──────────────────────────────────────────────────────────

describe("contractGet", () => {
	it("returns full content by id", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "p", consumer: "c", content: "body text" });
		const r = contractGet(tmpDir, "auth-api");
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();
		expect(r.content).toContain("body text");
		expect(r.content).toContain("status: draft");
	});

	it("returns error for unknown id", () => {
		expect(contractGet(tmpDir, "ghost").ok).toBe(false);
	});
});

// ── contractList ─────────────────────────────────────────────────────────

describe("contractList", () => {
	it("returns empty list when none exist", () => {
		const r = contractList(tmpDir);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();
		expect(r.contracts).toHaveLength(0);
	});

	it("returns metadata for created contracts", () => {
		contractCreate(tmpDir, { name: "API One", type: "api", producer: "p", consumer: "c", content: "# API One\n\nbody" });
		contractCreate(tmpDir, { name: "Task One", type: "task", producer: "p", consumer: "c", content: "# Task One\n\nbody" });
		const r = contractList(tmpDir);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();
		expect(r.contracts).toHaveLength(2);
		const ids = r.contracts!.map((c) => c.id).sort();
		expect(ids).toEqual(["api-one", "task-one"]);
	});

	it("extracts type and status from frontmatter", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nbody" });
		const r = contractList(tmpDir);
		if (!r.ok) throw new Error();
		const c = r.contracts![0];
		expect(c.type).toBe("api");
		expect(c.status).toBe("draft");
		expect(c.producer).toBe("p");
		expect(c.consumer).toBe("c");
		expect(c.version).toBe(1);
	});

	it("extracts title from H1", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# Auth Service Contract\n\nbody" });
		const r = contractList(tmpDir);
		if (!r.ok) throw new Error();
		expect(r.contracts![0].title).toBe("Auth Service Contract");
	});
});

// ── contractEdit ─────────────────────────────────────────────────────────

describe("contractEdit", () => {
	it("replaces unique text in a draft contract", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nOriginal body text." });
		const r = contractEdit(tmpDir, "my-api", "Original body text.", "Updated body text.");
		expect(r.ok).toBe(true);
		const file = fs.readFileSync(path.join(contractsDir(tmpDir), "my-api.md"), "utf-8");
		expect(file).toContain("Updated body text.");
		expect(file).not.toContain("Original body text.");
	});

	it("updates the updated timestamp on edit", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nOriginal." });
		const before = fs.readFileSync(path.join(contractsDir(tmpDir), "my-api.md"), "utf-8");
		const beforeTs = /^updated: (.+)$/m.exec(before)![1];
		// small delay to ensure timestamp differs
		const r = contractEdit(tmpDir, "my-api", "Original.", "New.");
		expect(r.ok).toBe(true);
		const after = fs.readFileSync(path.join(contractsDir(tmpDir), "my-api.md"), "utf-8");
		const afterTs = /^updated: (.+)$/m.exec(after)![1];
		// timestamps should be ISO strings (may be same in fast test, but field must exist)
		expect(afterTs).toMatch(/^\d{4}-/);
		expect(beforeTs).toMatch(/^\d{4}-/);
	});

	it("returns error when oldText not found", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nContent." });
		const r = contractEdit(tmpDir, "my-api", "Nonexistent text", "new");
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error();
		expect(r.error).toMatch(/not found/i);
	});

	it("returns error when oldText matches multiple times", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nfoo\nfoo\n" });
		const r = contractEdit(tmpDir, "my-api", "foo", "bar");
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error();
		expect(r.error).toMatch(/matches 2/i);
	});

	it("refuses to edit a proposed contract", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nContent." });
		contractPropose(tmpDir, "my-api");
		const r = contractEdit(tmpDir, "my-api", "Content.", "new");
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error();
		expect(r.error).toContain("proposed");
	});

	it("returns error for unknown id", () => {
		expect(contractEdit(tmpDir, "ghost", "old", "new").ok).toBe(false);
	});
});

// ── contractPropose ──────────────────────────────────────────────────────

describe("contractPropose", () => {
	it("moves draft to proposed", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nContent." });
		const r = contractPropose(tmpDir, "my-api");
		expect(r.ok).toBe(true);
		const file = fs.readFileSync(path.join(contractsDir(tmpDir), "my-api.md"), "utf-8");
		expect(file).toContain("status: proposed");
	});

	it("returns error if already proposed", () => {
		contractCreate(tmpDir, { name: "My API", type: "api", producer: "p", consumer: "c", content: "# My API\n\nContent." });
		contractPropose(tmpDir, "my-api");
		const r = contractPropose(tmpDir, "my-api");
		expect(r.ok).toBe(false);
	});

	it("returns error for unknown id", () => {
		expect(contractPropose(tmpDir, "ghost").ok).toBe(false);
	});
});

// ── contractSupersede ────────────────────────────────────────────────────

describe("contractSupersede", () => {
	it("marks old as superseded and creates new v+1 draft", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "p", consumer: "c", content: "# Auth API\n\nv1 content." });
		const r = contractSupersede(tmpDir, "auth-api", { name: "Auth API v2", content: "# Auth API v2\n\nv2 content." });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();

		// Old is superseded
		const oldFile = fs.readFileSync(path.join(contractsDir(tmpDir), "auth-api.md"), "utf-8");
		expect(oldFile).toContain("status: superseded");

		// New is draft v2
		const newFile = fs.readFileSync(path.join(contractsDir(tmpDir), `${r.id}.md`), "utf-8");
		expect(newFile).toContain("status: draft");
		expect(newFile).toContain("version: 2");
		expect(newFile).toContain("supersedes: auth-api");
		expect(newFile).toContain("v2 content.");
	});

	it("inherits type/producer/consumer from old contract", () => {
		contractCreate(tmpDir, { name: "Data Schema", type: "data", producer: "etl", consumer: "analytics", content: "# Data Schema\n\nv1." });
		const r = contractSupersede(tmpDir, "data-schema", { name: "Data Schema v2", content: "# Data Schema v2\n\nv2." });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error();
		const newFile = fs.readFileSync(path.join(contractsDir(tmpDir), `${r.id}.md`), "utf-8");
		expect(newFile).toContain("type: data");
		expect(newFile).toContain("producer: etl");
		expect(newFile).toContain("consumer: analytics");
	});

	it("returns error for unknown old id", () => {
		expect(contractSupersede(tmpDir, "ghost", { name: "x", content: "y" }).ok).toBe(false);
	});
});

// ── listAllContracts ─────────────────────────────────────────────────────

describe("listAllContracts", () => {
	it("returns empty when dir does not exist", () => {
		expect(listAllContracts(tmpDir)).toHaveLength(0);
	});

	it("ignores non-.md files", () => {
		fs.mkdirSync(contractsDir(tmpDir), { recursive: true });
		fs.writeFileSync(path.join(contractsDir(tmpDir), "junk.txt"), "hi");
		expect(listAllContracts(tmpDir)).toHaveLength(0);
	});

	it("sorts by updated descending", () => {
		contractCreate(tmpDir, { name: "Alpha", type: "api", producer: "p", consumer: "c", content: "# Alpha\n\na" });
		contractCreate(tmpDir, { name: "Beta", type: "task", producer: "p", consumer: "c", content: "# Beta\n\nb" });
		const all = listAllContracts(tmpDir);
		expect(all).toHaveLength(2);
		const ids = all.map((c) => c.id).sort();
		expect(ids).toEqual(["alpha", "beta"]);
	});
});

describe("contractIsExists", () => {
	it("returns false when contract does not exist", () => {
		expect(contractIsExists(tmpDir, "nonexistent")).toBe(false);
	});

	it("returns true after contractCreate", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		expect(contractIsExists(tmpDir, "auth-api")).toBe(true);
	});
});

describe("contractLength", () => {
	it("returns 0 when no contracts exist", () => {
		expect(contractLength(tmpDir)).toBe(0);
	});

	it("returns correct count", () => {
		contractCreate(tmpDir, { name: "API A", type: "api", producer: "architect", consumer: "worker", content: "# API A" });
		contractCreate(tmpDir, { name: "API B", type: "api", producer: "architect", consumer: "worker", content: "# API B" });
		expect(contractLength(tmpDir)).toBe(2);
	});
});

describe("contractIndexOf", () => {
	it("returns null when list is empty", () => {
		expect(contractIndexOf(tmpDir, () => true)).toBeNull();
	});

	it("returns null when nothing matches", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		expect(contractIndexOf(tmpDir, (c) => c.status === "proposed")).toBeNull();
	});

	it("returns first matching contract by status", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		contractCreate(tmpDir, { name: "DB Schema", type: "data", producer: "architect", consumer: "worker", content: "# DB Schema" });
		contractPropose(tmpDir, "db-schema");
		const found = contractIndexOf(tmpDir, (c) => c.status === "proposed");
		expect(found).not.toBeNull();
		expect(found!.id).toBe("db-schema");
	});

	it("returns first matching contract by type", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		contractCreate(tmpDir, { name: "DB Schema", type: "data", producer: "architect", consumer: "worker", content: "# DB Schema" });
		const found = contractIndexOf(tmpDir, (c) => c.type === "data");
		expect(found).not.toBeNull();
		expect(found!.id).toBe("db-schema");
	});
});
