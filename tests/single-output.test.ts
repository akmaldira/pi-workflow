/**
 * Tests for single-output.ts — File-based output handling
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureSingleOutputSnapshot,
	extractChildWrittenOutput,
	formatSavedOutputReference,
	injectOutputPathSystemPrompt,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutput,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
	finalizeSingleOutput,
} from "../extensions/single-output.ts";

describe("single-output", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = path.join(require("node:os").tmpdir(), `pi-test-output-${Date.now()}`);
		fs.mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("normalizeSingleOutputOverride", () => {
		it("should return false for false", () => {
			expect(normalizeSingleOutputOverride(false, "default")).toBe(false);
		});

		it("should return false for 'false' string", () => {
			expect(normalizeSingleOutputOverride("false", "default")).toBe(false);
		});

		it("should return default for true", () => {
			expect(normalizeSingleOutputOverride(true, "default")).toBe("default");
		});

		it("should return default for 'true' string", () => {
			expect(normalizeSingleOutputOverride("true", "default")).toBe("default");
		});

		it("should return string for string input", () => {
			expect(normalizeSingleOutputOverride("/path/to/file", "default")).toBe("/path/to/file");
		});

		it("should return undefined for undefined", () => {
			expect(normalizeSingleOutputOverride(undefined, "default")).toBeUndefined();
		});

		it("should return undefined for empty string", () => {
			expect(normalizeSingleOutputOverride("", "default")).toBeUndefined();
		});
	});

	describe("resolveSingleOutputPath", () => {
		it("should return undefined for non-string output", () => {
			expect(resolveSingleOutputPath(false, tmpDir)).toBeUndefined();
			expect(resolveSingleOutputPath(undefined, tmpDir)).toBeUndefined();
		});

		it("should return absolute path for absolute output", () => {
			expect(resolveSingleOutputPath("/absolute/path", tmpDir)).toBe("/absolute/path");
		});

		it("should resolve relative to cwd", () => {
			expect(resolveSingleOutputPath("relative.txt", tmpDir)).toBe(path.resolve(tmpDir, "relative.txt"));
		});

		it("should resolve relative to requestedCwd", () => {
			expect(resolveSingleOutputPath("output.txt", tmpDir, "/custom/cwd")).toBe("/custom/cwd/output.txt");
		});

		it("should resolve relative to relativeBaseDir", () => {
			expect(resolveSingleOutputPath("output.txt", tmpDir, undefined, "/base/dir")).toBe("/base/dir/output.txt");
		});

		it("should return undefined for 'true' and 'false' strings", () => {
			expect(resolveSingleOutputPath("true", tmpDir)).toBeUndefined();
			expect(resolveSingleOutputPath("false", tmpDir)).toBeUndefined();
		});
	});

	describe("injectSingleOutputInstruction", () => {
		it("should return task unchanged when no output path", () => {
			expect(injectSingleOutputInstruction("Task: hello", undefined)).toBe("Task: hello");
		});

		it("should append output instruction", () => {
			const result = injectSingleOutputInstruction("Task: hello", "/output.txt");
			expect(result).toContain("Task: hello");
			expect(result).toContain("/output.txt");
			expect(result).toContain("---");
		});
	});

	describe("injectOutputPathSystemPrompt", () => {
		it("should return prompt unchanged when no output path", () => {
			expect(injectOutputPathSystemPrompt("Hello", undefined)).toBe("Hello");
		});

		it("should append output path instruction", () => {
			const result = injectOutputPathSystemPrompt("Hello", "/output.txt");
			expect(result).toContain("Hello");
			expect(result).toContain("/output.txt");
		});
	});

	describe("formatSavedOutputReference", () => {
		it("should format output reference", () => {
			const ref = formatSavedOutputReference("/output.txt", "Hello world");
			expect(ref.path).toBe(path.resolve("/output.txt"));
			expect(ref.bytes).toBe(11);
			expect(ref.lines).toBe(1);
			expect(ref.message).toContain("Output saved to");
		});

		it("should handle multi-line output", () => {
			const ref = formatSavedOutputReference("/output.txt", "line1\nline2\nline3");
			expect(ref.lines).toBe(3);
			expect(ref.message).toContain("3 lines");
		});
	});

	describe("validateFileOnlyOutputMode", () => {
		it("should return undefined when outputMode is not file-only", () => {
			expect(validateFileOnlyOutputMode("inline", "/output.txt", "test")).toBeUndefined();
			expect(validateFileOnlyOutputMode(undefined, "/output.txt", "test")).toBeUndefined();
		});

		it("should return error when file-only without output path", () => {
			const error = validateFileOnlyOutputMode("file-only", undefined, "test");
			expect(error).toContain("file-only");
			expect(error).toContain("output file");
		});

		it("should return undefined when file-only with output path", () => {
			expect(validateFileOnlyOutputMode("file-only", "/output.txt", "test")).toBeUndefined();
		});
	});

	describe("captureSingleOutputSnapshot", () => {
		it("should return undefined when no output path", () => {
			expect(captureSingleOutputSnapshot(undefined)).toBeUndefined();
		});

		it("should capture existing file stats", () => {
			const filePath = path.join(tmpDir, "output.txt");
			fs.writeFileSync(filePath, "Hello world");
			const snapshot = captureSingleOutputSnapshot(filePath);
			expect(snapshot?.exists).toBe(true);
			expect(snapshot?.size).toBe(11);
		});

		it("should return exists:false for non-existent file", () => {
			const snapshot = captureSingleOutputSnapshot(path.join(tmpDir, "nonexistent.txt"));
			expect(snapshot?.exists).toBe(false);
		});
	});

	describe("resolveSingleOutput", () => {
		it("should return fallback when no output path", () => {
			const result = resolveSingleOutput(undefined, "fallback", undefined);
			expect(result.fullOutput).toBe("fallback");
		});

		it("should read changed file", () => {
			const filePath = path.join(tmpDir, "output.txt");
			fs.writeFileSync(filePath, "file content");
			const beforeRun = { exists: false };
			const result = resolveSingleOutput(filePath, "fallback", beforeRun);
			expect(result.fullOutput).toBe("file content");
			expect(result.savedPath).toBe(filePath);
		});

		it("should write fallback when file unchanged", () => {
			const filePath = path.join(tmpDir, "output.txt");
			fs.writeFileSync(filePath, "existing content");
			const stat = fs.statSync(filePath);
			const beforeRun = { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
			const result = resolveSingleOutput(filePath, "new content", beforeRun);
			expect(result.fullOutput).toBe("new content");
			expect(result.savedPath).toBe(filePath);
		});

		it("should use fallback when file doesn't exist and beforeRun says it exists", () => {
			const filePath = path.join(tmpDir, "nonexistent.txt");
			const beforeRun = { exists: true, mtimeMs: 1000, size: 100 };
			const result = resolveSingleOutput(filePath, "fallback", beforeRun);
			expect(result.fullOutput).toBe("fallback");
			expect(result.savedPath).toBe(filePath);
		});
	});

	describe("finalizeSingleOutput", () => {
		it("should return display output for failed exit code", () => {
			const result = finalizeSingleOutput({
				fullOutput: "output",
				exitCode: 1,
			});
			expect(result.displayOutput).toBe("output");
			expect(result.savedPath).toBeUndefined();
		});

		it("should add output reference for successful save", () => {
			const result = finalizeSingleOutput({
				fullOutput: "output",
				exitCode: 0,
				savedPath: "/output.txt",
			});
			expect(result.displayOutput).toContain("output");
			expect(result.displayOutput).toContain("Output saved to");
			expect(result.savedPath).toBe("/output.txt");
			expect(result.outputReference).toBeDefined();
		});

		it("should return file-only message for file-only mode", () => {
			const result = finalizeSingleOutput({
				fullOutput: "Hello world content here",
				outputMode: "file-only",
				exitCode: 0,
				savedPath: "/output.txt",
			});
			expect(result.displayOutput).toContain("Output saved to");
			expect(result.displayOutput).not.toContain("Hello world content here");
		});

		it("should add save error message", () => {
			const result = finalizeSingleOutput({
				fullOutput: "output",
				outputPath: "/output.txt",
				saveError: "Permission denied",
				exitCode: 0,
			});
			expect(result.displayOutput).toContain("Output file error");
			expect(result.displayOutput).toContain("Permission denied");
		});
	});

	describe("extractChildWrittenOutput", () => {
		it("should return undefined when no messages", () => {
			expect(extractChildWrittenOutput(undefined, "/output.txt")).toBeUndefined();
		});

		it("should return undefined when no output path", () => {
			expect(extractChildWrittenOutput([], undefined)).toBeUndefined();
		});

		it("should extract content from write tool call", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "write",
							arguments: { path: "/output.txt", content: "file content" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					isError: false,
					content: "success",
				},
			];
			const result = extractChildWrittenOutput(messages as unknown as Message[], "/output.txt");
			expect(result).toBe("file content");
		});

		it("should return undefined when write tool call failed", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "write",
							arguments: { path: "/output.txt", content: "file content" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					isError: true,
					content: "error",
				},
			];
			const result = extractChildWrittenOutput(messages as unknown as Message[], "/output.txt");
			expect(result).toBeUndefined();
		});

		it("should return undefined when path doesn't match", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "write",
							arguments: { path: "/other.txt", content: "content" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					isError: false,
					content: "success",
				},
			];
			const result = extractChildWrittenOutput(messages as unknown as Message[], "/output.txt");
			expect(result).toBeUndefined();
		});
	});
});
