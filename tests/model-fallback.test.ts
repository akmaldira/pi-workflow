/**
 * Tests for model-fallback.ts — Model resolution and fallback
 */

import { describe, expect, it } from "vitest";
import {
	buildModelCandidates,
	fuzzyResolveModel,
	normalizeModelSegment,
	resolveModelCandidate,
	resolveSubagentModelOverride,
	splitThinkingSuffix,
} from "../extensions/model-fallback.ts";
import type { ModelInfo } from "../extensions/model-info.ts";

const mockModels: ModelInfo[] = [
	{ provider: "google", id: "gemini-2.5-pro", fullId: "google/gemini-2.5-pro" },
	{ provider: "google", id: "gemini-2.5-flash", fullId: "google/gemini-2.5-flash" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "anthropic", id: "claude-3-7-sonnet", fullId: "anthropic/claude-3-7-sonnet" },
	{ provider: "openai", id: "gpt-4.1", fullId: "openai/gpt-4.1" },
	{ provider: "openai", id: "o3-pro", fullId: "openai/o3-pro" },
];

describe("model-fallback", () => {
	describe("normalizeModelSegment", () => {
		it("should lowercase", () => {
			expect(normalizeModelSegment("GEMINI")).toBe("gemini");
		});

		it("should replace dots and underscores with dashes", () => {
			expect(normalizeModelSegment("2.5_pro")).toBe("2-5-pro");
		});

		it("should collapse repeated dashes", () => {
			expect(normalizeModelSegment("a--b___c")).toBe("a-b-c");
		});

		it("should trim leading/trailing dashes", () => {
			expect(normalizeModelSegment("-test-")).toBe("test");
		});
	});

	describe("resolveModelCandidate", () => {
		it("should resolve exact fullId match", () => {
			expect(resolveModelCandidate("google/gemini-2.5-pro", mockModels)).toBe("google/gemini-2.5-pro");
		});

		it("should resolve exact id match", () => {
			expect(resolveModelCandidate("gemini-2.5-pro", mockModels)).toBe("google/gemini-2.5-pro");
		});

		it("should resolve with thinking suffix", () => {
			expect(resolveModelCandidate("google/gemini-2.5-pro:high", mockModels)).toBe("google/gemini-2.5-pro:high");
		});

		it("should resolve fuzzy match with separator differences", () => {
			expect(resolveModelCandidate("google/gemini_2_5_pro", mockModels)).toBe("google/gemini-2.5-pro");
		});

		it("should return original model when no match found", () => {
			expect(resolveModelCandidate("unknown/model", mockModels)).toBe("unknown/model");
		});

		it("should return undefined when model is undefined", () => {
			expect(resolveModelCandidate(undefined, mockModels)).toBeUndefined();
		});

		it("should return model as-is when no available models", () => {
			expect(resolveModelCandidate("google/gemini", undefined)).toBe("google/gemini");
		});

		it("should prefer provider when ambiguous", () => {
			const models: ModelInfo[] = [
				{ provider: "google", id: "pro", fullId: "google/pro" },
				{ provider: "anthropic", id: "pro", fullId: "anthropic/pro" },
			];
			expect(resolveModelCandidate("pro", models, "google")).toBe("google/pro");
		});
	});

	describe("fuzzyResolveModel", () => {
		it("should resolve with case differences", () => {
			expect(fuzzyResolveModel("Google/Gemini-2.5-Pro", mockModels)).toBe("google/gemini-2.5-pro");
		});

		it("should resolve with date stamp differences", () => {
			const models: ModelInfo[] = [
				{ provider: "google", id: "gemini-2.5-pro", fullId: "google/gemini-2.5-pro" },
			];
			// Without a matching dated model, should resolve the base model
			expect(fuzzyResolveModel("gemini-2.5-pro-2025-01-01", models)).toBe("google/gemini-2.5-pro");
		});

		it("should return undefined for ambiguous matches", () => {
			const models: ModelInfo[] = [
				{ provider: "google", id: "pro", fullId: "google/pro" },
				{ provider: "anthropic", id: "pro", fullId: "anthropic/pro" },
			];
			expect(fuzzyResolveModel("pro", models)).toBeUndefined();
		});

		it("should not switch providers for qualified queries", () => {
			expect(fuzzyResolveModel("google/unknown-model", mockModels)).toBeUndefined();
		});
	});

	describe("buildModelCandidates", () => {
		it("should build candidates from primary and fallback models", () => {
			const candidates = buildModelCandidates(
				"google/gemini-2.5-pro",
				["google/gemini-2.5-flash", "anthropic/claude-sonnet-4"],
				mockModels,
			);
			expect(candidates).toEqual([
				"google/gemini-2.5-pro",
				"google/gemini-2.5-flash",
				"anthropic/claude-sonnet-4",
			]);
		});

		it("should deduplicate candidates", () => {
			const candidates = buildModelCandidates(
				"google/gemini-2.5-pro",
				["google/gemini-2.5-pro", "google/gemini-2.5-flash"],
				mockModels,
			);
			expect(candidates).toEqual([
				"google/gemini-2.5-pro",
				"google/gemini-2.5-flash",
			]);
		});

		it("should skip undefined models", () => {
			const candidates = buildModelCandidates(
				undefined,
				["google/gemini-2.5-flash"],
				mockModels,
			);
			expect(candidates).toEqual(["google/gemini-2.5-flash"]);
		});

		it("should return empty array when no models", () => {
			const candidates = buildModelCandidates(undefined, undefined, mockModels);
			expect(candidates).toEqual([]);
		});
	});

	describe("resolveSubagentModelOverride", () => {
		it("should use parent model when requestedModel is undefined", () => {
			const result = resolveSubagentModelOverride(
				undefined,
				{ provider: "google", id: "gemini-2.5-pro" },
				mockModels,
			);
			expect(result).toBe("google/gemini-2.5-pro");
		});

		it("should use parent model when requestedModel is 'inherit'", () => {
			const result = resolveSubagentModelOverride(
				"inherit",
				{ provider: "google", id: "gemini-2.5-pro" },
				mockModels,
			);
			expect(result).toBe("google/gemini-2.5-pro");
		});

		it("should resolve explicit model", () => {
			const result = resolveSubagentModelOverride(
				"google/gemini-2.5-flash",
				{ provider: "google", id: "gemini-2.5-pro" },
				mockModels,
			);
			expect(result).toBe("google/gemini-2.5-flash");
		});

		it("should return undefined when no parent model and no explicit model", () => {
			const result = resolveSubagentModelOverride(undefined, undefined, mockModels);
			expect(result).toBeUndefined();
		});

		it("should enforce scope for explicit models", () => {
			expect(() =>
				resolveSubagentModelOverride(
					"google/gemini-2.5-pro",
					undefined,
					mockModels,
					undefined,
					{
						scope: { enforce: true, allow: ["anthropic/*"] },
						source: "explicit",
					},
				),
			).toThrow();
		});

		it("should warn for inherited models outside scope", () => {
			const warnings: string[] = [];
			const result = resolveSubagentModelOverride(
				undefined,
				{ provider: "google", id: "gemini-2.5-pro" },
				mockModels,
				undefined,
				{
					scope: { enforce: true, allow: ["anthropic/*"] },
					source: "inherited",
					onWarn: (v) => warnings.push(v.message),
				},
			);
			expect(result).toBe("google/gemini-2.5-pro");
			expect(warnings.length).toBe(1);
		});
	});
});
