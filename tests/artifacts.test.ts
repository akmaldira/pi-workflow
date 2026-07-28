/**
 * Tests for artifacts.ts — Artifact management
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupOldArtifacts,
	ensureArtifactsDir,
	formatOutputArtifactContent,
	getArtifactPaths,
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectSubagentsDir,
	writeArtifact,
	writeMetadata,
	appendJsonl,
} from "../extensions/artifacts.ts";

describe("artifacts", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = path.join(require("node:os").tmpdir(), `pi-test-artifacts-${Date.now()}`);
		fs.mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("getProjectSubagentsDir", () => {
		it("should return .pi-subagents in cwd", () => {
			expect(getProjectSubagentsDir("/some/path")).toBe(path.join("/some/path", ".pi-subagents"));
		});
	});

	describe("getProjectArtifactsDir", () => {
		it("should return artifacts dir in .pi-subagents", () => {
			expect(getProjectArtifactsDir("/some/path")).toBe(
				path.join("/some/path", ".pi-subagents", "artifacts"),
			);
		});
	});

	describe("getArtifactsDir", () => {
		it("should return run-specific directory", () => {
			const result = getArtifactsDir("/base", "run-123", "researcher");
			expect(result).toContain("run-123-researcher");
		});

		it("should include index in directory name", () => {
			const result = getArtifactsDir("/base", "run-123", "researcher", 2);
			expect(result).toContain("run-123-researcher-2");
		});

		it("should sanitize agent name", () => {
			const result = getArtifactsDir("/base", "run-123", "agent/with/slashes");
			expect(result).toContain("agent_with_slashes");
		});
	});

	describe("getArtifactPaths", () => {
		it("should return all artifact paths", () => {
			const paths = getArtifactPaths("/artifacts", "run-123", "researcher");
			expect(paths.inputPath).toContain("input.md");
			expect(paths.outputPath).toContain("output.md");
			expect(paths.jsonlPath).toContain("events.jsonl");
			expect(paths.transcriptPath).toContain("transcript.jsonl");
			expect(paths.metadataPath).toContain("metadata.json");
		});

		it("should include index in paths", () => {
			const paths = getArtifactPaths("/artifacts", "run-123", "researcher", 1);
			expect(paths.inputPath).toContain("run-123-researcher-1");
		});
	});

	describe("ensureArtifactsDir", () => {
		it("should create directory recursively", () => {
			const dir = path.join(tmpDir, "nested", "dir");
			ensureArtifactsDir(dir);
			expect(fs.existsSync(dir)).toBe(true);
		});
	});

	describe("writeArtifact", () => {
		it("should write content to file", () => {
			const filePath = path.join(tmpDir, "test.md");
			writeArtifact(filePath, "Hello world");
			expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello world");
		});

		it("should create parent directories", () => {
			const filePath = path.join(tmpDir, "nested", "dir", "test.md");
			writeArtifact(filePath, "Hello");
			expect(fs.existsSync(filePath)).toBe(true);
		});
	});

	describe("writeMetadata", () => {
		it("should write JSON metadata", () => {
			const filePath = path.join(tmpDir, "metadata.json");
			writeMetadata(filePath, { agent: "test", exitCode: 0 });
			const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			expect(content.agent).toBe("test");
			expect(content.exitCode).toBe(0);
		});
	});

	describe("appendJsonl", () => {
		it("should append JSON line to file", () => {
			const filePath = path.join(tmpDir, "events.jsonl");
			appendJsonl(filePath, JSON.stringify({ type: "test", value: 1 }));
			appendJsonl(filePath, JSON.stringify({ type: "test", value: 2 }));
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]).value).toBe(1);
			expect(JSON.parse(lines[1]).value).toBe(2);
		});

		it("should create parent directories", () => {
			const filePath = path.join(tmpDir, "nested", "events.jsonl");
			appendJsonl(filePath, JSON.stringify({ test: true }));
			expect(fs.existsSync(filePath)).toBe(true);
		});
	});

	describe("formatOutputArtifactContent", () => {
		it("should return unchanged content when not truncated", () => {
			const result = formatOutputArtifactContent({
				output: "Hello world",
				truncated: false,
			});
			expect(result).toBe("Hello world");
		});

		it("should add truncation markers when truncated", () => {
			const result = formatOutputArtifactContent({
				output: "Hello world",
				truncated: true,
				originalBytes: 1000,
				originalLines: 50,
			});
			expect(result).toContain("Hello world");
			expect(result).toContain("original bytes: 1000");
			expect(result).toContain("original lines: 50");
		});

		it("should include artifact path when provided", () => {
			const result = formatOutputArtifactContent({
				output: "Hello",
				truncated: true,
				artifactPath: "/path/to/artifact",
			});
			expect(result).toContain("/path/to/artifact");
		});
	});

	describe("cleanupOldArtifacts", () => {
		it("should not throw when directory doesn't exist", () => {
			expect(() => cleanupOldArtifacts("/nonexistent/path", 7)).not.toThrow();
		});

		it("should remove old directories", () => {
			const baseDir = path.join(tmpDir, "artifacts");
			fs.mkdirSync(baseDir, { recursive: true });

			// Create old directory
			const oldDir = path.join(baseDir, "old-run");
			fs.mkdirSync(oldDir, { recursive: true });
			// Set mtime to 30 days ago
			const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
			const oldDate = new Date(oldTime);
			fs.writeFileSync(path.join(oldDir, "marker.txt"), "old");
			fs.utimesSync(path.join(oldDir, "marker.txt"), oldDate, oldDate);
			fs.utimesSync(oldDir, oldDate, oldDate);

			// Create new directory
			const newDir = path.join(baseDir, "new-run");
			fs.mkdirSync(newDir, { recursive: true });

			cleanupOldArtifacts(baseDir, 7);

			expect(fs.existsSync(oldDir)).toBe(false);
			expect(fs.existsSync(newDir)).toBe(true);
		});

		it("should keep recent directories", () => {
			const baseDir = path.join(tmpDir, "artifacts");
			fs.mkdirSync(baseDir, { recursive: true });

			const recentDir = path.join(baseDir, "recent-run");
			fs.mkdirSync(recentDir, { recursive: true });

			cleanupOldArtifacts(baseDir, 7);
			expect(fs.existsSync(recentDir)).toBe(true);
		});
	});
});
