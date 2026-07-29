import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RunJournal, hashString, agentCallKey } from "../extensions/journal.ts";

describe("Journal: JSONL Persistence & Resume", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `journal-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("hashString", () => {
		it("produces consistent hashes", () => {
			const input = "hello world";
			const hash1 = hashString(input);
			const hash2 = hashString(input);
			expect(hash1).toBe(hash2);
		});

		it("produces different hashes for different inputs", () => {
			const hash1 = hashString("script 1");
			const hash2 = hashString("script 2");
			expect(hash1).not.toBe(hash2);
		});

		it("produces 8-character hex strings", () => {
			const hash = hashString("test");
			expect(hash).toMatch(/^[a-f0-9]{8}$/);
		});
	});

	describe("agentCallKey", () => {
		it("produces unique keys for different prompts", () => {
			const key1 = agentCallKey("task 1", {});
			const key2 = agentCallKey("task 2", {});
			expect(key1).not.toBe(key2);
		});

		it("produces same key for same prompt and options", () => {
			const key1 = agentCallKey("task", { model: "gpt-4" });
			const key2 = agentCallKey("task", { model: "gpt-4" });
			expect(key1).toBe(key2);
		});

		it("produces different keys for different options", () => {
			const key1 = agentCallKey("task", { model: "gpt-4" });
			const key2 = agentCallKey("task", { model: "claude" });
			expect(key1).not.toBe(key2);
		});
	});

	describe("RunJournal.create", () => {
		it("creates a new JSONL file", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			expect(fs.existsSync(journal.filePath)).toBe(true);
		});

		it("writes run metadata as first line", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow", "A test workflow");
			const content = fs.readFileSync(journal.filePath, "utf8");
			const lines = content.split("\n").filter(Boolean);
			expect(lines.length).toBeGreaterThanOrEqual(1);

			const meta = JSON.parse(lines[0]);
			expect(meta.type).toBe("run");
			expect(meta.name).toBe("test_workflow");
			expect(meta.description).toBe("A test workflow");
			expect(meta.scriptHash).toBe("abc12345");
		});

		it("initializes stats correctly", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			const stats = journal.getStats();
			expect(stats.agentCount).toBe(0);
			expect(stats.totalTokens).toBe(0);
			expect(stats.seq).toBe(0);
		});
	});

	describe("RunJournal.recordAgent", () => {
		it("logs successful agent execution", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordAgent("key1", "Agent 1", "result text", 100, 1000);

			const content = fs.readFileSync(journal.filePath, "utf8");
			const lines = content.split("\n").filter(Boolean);
			expect(lines.length).toBe(2); // meta + agent record

			const record = JSON.parse(lines[1]);
			expect(record.type).toBe("agent");
			expect(record.label).toBe("Agent 1");
			expect(record.result).toBe("result text");
			expect(record.outputTokens).toBe(100);
		});

		it("accumulates token counts", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordAgent("key1", "Agent 1", "result 1", 100);
			journal.recordAgent("key2", "Agent 2", "result 2", 150);

			const stats = journal.getStats();
			expect(stats.agentCount).toBe(2);
			expect(stats.totalTokens).toBe(250);
		});
	});

	describe("RunJournal.recordError", () => {
		it("logs agent failure", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordError("key1", "Agent 1", "Task failed", 500);

			const content = fs.readFileSync(journal.filePath, "utf8");
			const lines = content.split("\n").filter(Boolean);
			const record = JSON.parse(lines[1]);
			expect(record.error).toBe("Task failed");
			expect(record.result).toBeUndefined();
		});
	});

	describe("RunJournal.getCachedResult", () => {
		it("returns cached result when recorded", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordAgent("key1", "Agent 1", "cached_result", 100);

			const cached = journal.getCachedResult("key1");
			expect(cached).toEqual({ result: "cached_result", outputTokens: 100 });
		});

		it("returns null for non-existent key", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			const cached = journal.getCachedResult("nonexistent");
			expect(cached).toBeNull();
		});
	});

	describe("RunJournal.resume", () => {
		it("loads prior results when script hash matches", () => {
			// Create initial run
			const journal1 = RunJournal.create(tempDir, "hash123", "workflow");
			journal1.recordAgent("key1", "Agent 1", "result1", 100);
			journal1.recordAgent("key2", "Agent 2", "result2", 150);
			journal1.recordResult(true, "final_result", undefined, 5000);

			// Resume with same script hash
			const resumed = RunJournal.resume(tempDir, journal1.runId, "hash123", "workflow");
			expect(resumed.isCacheValid).toBe(true);
			expect(resumed.priorAgentCount).toBe(2);

			// Check cached results
			const cached1 = resumed.journal.getCachedResult("key1");
			const cached2 = resumed.journal.getCachedResult("key2");
			expect(cached1?.result).toBe("result1");
			expect(cached2?.result).toBe("result2");
		});

		it("invalidates cache when script hash differs", () => {
			// Create initial run with hash123
			const journal1 = RunJournal.create(tempDir, "hash123", "workflow");
			journal1.recordAgent("key1", "Agent 1", "result1", 100);

			// Resume with different hash hash456
			const resumed = RunJournal.resume(tempDir, journal1.runId, "hash456", "workflow");
			expect(resumed.isCacheValid).toBe(false);
			expect(resumed.priorAgentCount).toBe(0);

			// Cache should be empty (new run)
			const cached = resumed.journal.getCachedResult("key1");
			expect(cached).toBeNull();
		});

		it("creates new run if file doesn't exist", () => {
			const resumed = RunJournal.resume(tempDir, "nonexistent-run-id", "hash123", "workflow");
			expect(resumed.isCacheValid).toBe(false);
			expect(resumed.priorAgentCount).toBe(0);
			expect(fs.existsSync(resumed.journal.filePath)).toBe(true);
		});
	});

	describe("RunJournal.recordResult", () => {
		it("logs workflow completion", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordAgent("key1", "Agent 1", "result", 100);
			journal.recordResult(true, { data: "final" }, undefined, 2000);

			const content = fs.readFileSync(journal.filePath, "utf8");
			const lines = content.split("\n").filter(Boolean);

			const resultRecord = JSON.parse(lines[lines.length - 1]);
			expect(resultRecord.type).toBe("result");
			expect(resultRecord.ok).toBe(true);
			expect(resultRecord.result).toEqual({ data: "final" });
			expect(resultRecord.agentCount).toBe(1);
			expect(resultRecord.totalTokens).toBe(100);
		});

		it("logs workflow error", () => {
			const journal = RunJournal.create(tempDir, "abc12345", "test_workflow");
			journal.recordError("key1", "Agent 1", "Failed", 1000);
			journal.recordResult(false, undefined, "Workflow failed", 1500);

			const content = fs.readFileSync(journal.filePath, "utf8");
			const lines = content.split("\n").filter(Boolean);

			const resultRecord = JSON.parse(lines[lines.length - 1]);
			expect(resultRecord.ok).toBe(false);
			expect(resultRecord.error).toBe("Workflow failed");
		});
	});

	describe("Full journal lifecycle", () => {
		it("persists and resumes a complete workflow run", () => {
			// Run 1: Create and record agents
			const journal1 = RunJournal.create(tempDir, "script_hash", "my_workflow", "Do something");
			journal1.recordAgent("key1", "Agent 1", { output: "step 1" }, 100);
			journal1.recordAgent("key2", "Agent 2", { output: "step 2" }, 150);
			journal1.recordResult(true, { summary: "complete" }, undefined, 5000);

			const runId = journal1.runId;
			const filePath = journal1.filePath;

			// Verify file was written
			expect(fs.existsSync(filePath)).toBe(true);
			const lines1 = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
			expect(lines1.length).toBe(4); // meta + 2 agents + result

			// Run 2: Resume with same script
			const resumed = RunJournal.resume(tempDir, runId, "script_hash", "my_workflow");
			expect(resumed.isCacheValid).toBe(true);
			expect(resumed.priorAgentCount).toBe(2);

			// Verify cache has both results
			expect(resumed.journal.getCachedResult("key1")).toBeDefined();
			expect(resumed.journal.getCachedResult("key2")).toBeDefined();

			// Add new agent (edited script)
			resumed.journal.recordAgent("key3", "Agent 3", { output: "step 3" }, 200);
			resumed.journal.recordResult(true, { summary: "complete v2" }, undefined, 3000);

			// Verify new record was appended
			const lines2 = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
			expect(lines2.length).toBeGreaterThan(lines1.length);
		});
	});
});
