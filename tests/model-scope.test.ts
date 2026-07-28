/**
 * Tests for model-scope.ts — Model scope enforcement
 */

import { describe, expect, it } from "vitest";
import {
	checkModelScope,
	matchesScopePattern,
	parseModelScopeConfig,
} from "../extensions/model-scope.ts";

describe("model-scope", () => {
	describe("matchesScopePattern", () => {
		it("should match exact model", () => {
			expect(matchesScopePattern("google/gemini", "google/gemini")).toBe(true);
		});

		it("should match with wildcard", () => {
			expect(matchesScopePattern("google/gemini", "google/*")).toBe(true);
		});

		it("should match with wildcard for provider", () => {
			expect(matchesScopePattern("google/gemini", "*/gemini")).toBe(true);
		});

		it("should not match different model", () => {
			expect(matchesScopePattern("google/gemini", "google/claude")).toBe(false);
		});

		it("should be case-insensitive", () => {
			expect(matchesScopePattern("Google/Gemini", "google/gemini")).toBe(true);
		});

		it("should strip thinking suffix before matching", () => {
			expect(matchesScopePattern("google/gemini:high", "google/gemini")).toBe(true);
		});
	});

	describe("checkModelScope", () => {
		it("should return undefined when no model", () => {
			expect(checkModelScope(undefined, { enforce: true, allow: ["google/*"] }, "explicit")).toBeUndefined();
		});

		it("should return undefined when no scope", () => {
			expect(checkModelScope("google/gemini", undefined, "explicit")).toBeUndefined();
		});

		it("should return undefined when enforce is false", () => {
			expect(checkModelScope("google/gemini", { enforce: false, allow: ["anthropic/*"] }, "explicit")).toBeUndefined();
		});

		it("should return undefined when no allow list", () => {
			expect(checkModelScope("google/gemini", { enforce: true }, "explicit")).toBeUndefined();
		});

		it("should return undefined when model matches allow pattern", () => {
			expect(checkModelScope("google/gemini", { enforce: true, allow: ["google/*"] }, "explicit")).toBeUndefined();
		});

		it("should return error for explicit model outside scope", () => {
			const violation = checkModelScope("google/gemini", { enforce: true, allow: ["anthropic/*"] }, "explicit");
			expect(violation).toBeDefined();
			expect(violation!.severity).toBe("error");
			expect(violation!.model).toBe("google/gemini");
		});

		it("should return warn for inherited model outside scope", () => {
			const violation = checkModelScope("google/gemini", { enforce: true, allow: ["anthropic/*"] }, "inherited");
			expect(violation).toBeDefined();
			expect(violation!.severity).toBe("warn");
		});

		it("should include allowed patterns in violation", () => {
			const violation = checkModelScope("google/gemini", { enforce: true, allow: ["anthropic/*", "openai/*"] }, "explicit");
			expect(violation!.allowedPatterns).toEqual(["anthropic/*", "openai/*"]);
		});
	});

	describe("parseModelScopeConfig", () => {
		it("should return undefined for undefined input", () => {
			expect(parseModelScopeConfig(undefined, { filePath: "test" })).toBeUndefined();
		});

		it("should parse valid config", () => {
			const result = parseModelScopeConfig(
				{ enforce: true, allow: ["google/*"] },
				{ filePath: "test" },
			);
			expect(result?.enforce).toBe(true);
			expect(result?.allow).toEqual(["google/*"]);
		});

		it("should throw for non-object input", () => {
			expect(() => parseModelScopeConfig("string", { filePath: "test" })).toThrow();
		});

		it("should throw for invalid enforce type", () => {
			expect(() => parseModelScopeConfig({ enforce: "yes" }, { filePath: "test" })).toThrow();
		});

		it("should throw for invalid allow type", () => {
			expect(() => parseModelScopeConfig({ allow: "google/*" }, { filePath: "test" })).toThrow();
		});

		it("should throw for empty allow array", () => {
			expect(() => parseModelScopeConfig({ enforce: true, allow: [] }, { filePath: "test" })).toThrow();
		});

		it("should throw for non-string allow entries", () => {
			expect(() => parseModelScopeConfig({ allow: [123] }, { filePath: "test" })).toThrow();
		});

		it("should throw for enforce without allow", () => {
			expect(() => parseModelScopeConfig({ enforce: true }, { filePath: "test" })).toThrow();
		});

		it("should trim allow entries", () => {
			const result = parseModelScopeConfig(
				{ enforce: true, allow: ["  google/*  "] },
				{ filePath: "test" },
			);
			expect(result?.allow).toEqual(["google/*"]);
		});

		it("should filter empty allow entries", () => {
			const result = parseModelScopeConfig(
				{ enforce: true, allow: ["", "google/*", ""] },
				{ filePath: "test" },
			);
			expect(result?.allow).toEqual(["google/*"]);
		});
	});
});
