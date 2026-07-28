/**
 * Tests for nested-path.ts — Nested path encoding/decoding
 */

import { describe, expect, it } from "vitest";
import {
	encodeNestedPathEnv,
	isSafeNestedPathId,
	parseNestedPathEnv,
	sanitizeNestedPath,
	MAX_NESTED_PATH_ENTRIES,
} from "../extensions/nested-path.ts";

describe("nested-path", () => {
	describe("isSafeNestedPathId", () => {
		it("should accept valid IDs", () => {
			expect(isSafeNestedPathId("run-123")).toBe(true);
			expect(isSafeNestedPathId("abc_def")).toBe(true);
			expect(isSafeNestedPathId("a.b.c")).toBe(true);
		});

		it("should reject absolute paths", () => {
			expect(isSafeNestedPathId("/absolute/path")).toBe(false);
		});

		it("should reject paths with slashes", () => {
			expect(isSafeNestedPathId("path/with/slash")).toBe(false);
		});

		it("should reject paths with backslashes", () => {
			expect(isSafeNestedPathId("path\\with\\backslash")).toBe(false);
		});

		it("should reject paths with ..", () => {
			expect(isSafeNestedPathId("path..with..dots")).toBe(false);
		});

		it("should reject empty strings", () => {
			expect(isSafeNestedPathId("")).toBe(false);
		});

		it("should reject non-strings", () => {
			expect(isSafeNestedPathId(123)).toBe(false);
			expect(isSafeNestedPathId(null)).toBe(false);
			expect(isSafeNestedPathId(undefined)).toBe(false);
		});

		it("should reject IDs over 128 characters", () => {
			expect(isSafeNestedPathId("A".repeat(129))).toBe(false);
		});

		it("should accept IDs at exactly 128 characters", () => {
			expect(isSafeNestedPathId("A".repeat(128))).toBe(true);
		});
	});

	describe("sanitizeNestedPath", () => {
		it("should return empty array for non-array input", () => {
			expect(sanitizeNestedPath("string")).toEqual([]);
			expect(sanitizeNestedPath(null)).toEqual([]);
			expect(sanitizeNestedPath(undefined)).toEqual([]);
		});

		it("should sanitize valid entries", () => {
			const input = [
				{ runId: "run-1", stepIndex: 0, agent: "researcher" },
				{ runId: "run-2", agent: "writer" },
			];
			const result = sanitizeNestedPath(input);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ runId: "run-1", stepIndex: 0, agent: "researcher" });
			expect(result[1]).toEqual({ runId: "run-2", agent: "writer" });
		});

		it("should filter out invalid entries", () => {
			const input = [
				{ runId: "valid" },
				{ invalid: true },
				{ runId: "/invalid/path" },
				{ runId: "also-valid", stepIndex: 5 },
			];
			const result = sanitizeNestedPath(input);
			expect(result).toHaveLength(2);
			expect(result[0].runId).toBe("valid");
			expect(result[1].runId).toBe("also-valid");
		});

		it("should truncate to MAX_NESTED_PATH_ENTRIES", () => {
			const input = Array.from({ length: 10 }, (_, i) => ({ runId: `run-${i}` }));
			const result = sanitizeNestedPath(input);
			expect(result).toHaveLength(MAX_NESTED_PATH_ENTRIES);
		});

		it("should handle non-object entries", () => {
			const input = [null, "string", 123, { runId: "valid" }];
			const result = sanitizeNestedPath(input);
			expect(result).toHaveLength(1);
			expect(result[0].runId).toBe("valid");
		});

		it("should handle missing agent field", () => {
			const result = sanitizeNestedPath([{ runId: "run-1" }]);
			expect(result[0]).toEqual({ runId: "run-1" });
		});
	});

	describe("encodeNestedPathEnv", () => {
		it("should encode valid path", () => {
			const path = [{ runId: "run-1", stepIndex: 0, agent: "test" }];
			const encoded = encodeNestedPathEnv(path);
			expect(encoded).toBe(JSON.stringify(path));
		});

		it("should return empty string for empty path", () => {
			expect(encodeNestedPathEnv([])).toBe("");
		});

		it("should sanitize before encoding", () => {
			const path = [{ runId: "run-1" }, { invalid: true }];
			const encoded = encodeNestedPathEnv(path);
			expect(encoded).toBe(JSON.stringify([{ runId: "run-1" }]));
		});
	});

	describe("parseNestedPathEnv", () => {
		it("should parse valid JSON", () => {
			const path = [{ runId: "run-1", stepIndex: 0 }];
			const encoded = JSON.stringify(path);
			const result = parseNestedPathEnv(encoded);
			expect(result).toEqual(path);
		});

		it("should return empty array for undefined", () => {
			expect(parseNestedPathEnv(undefined)).toEqual([]);
		});

		it("should return empty array for empty string", () => {
			expect(parseNestedPathEnv("")).toEqual([]);
		});

		it("should return empty array for invalid JSON", () => {
			expect(parseNestedPathEnv("not json")).toEqual([]);
		});

		it("should sanitize parsed entries", () => {
			const encoded = JSON.stringify([
				{ runId: "valid" },
				{ runId: "/invalid" },
			]);
			const result = parseNestedPathEnv(encoded);
			expect(result).toHaveLength(1);
			expect(result[0].runId).toBe("valid");
		});
	});
});
