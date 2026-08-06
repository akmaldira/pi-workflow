/**
 * Tests for acceptance.ts — Acceptance system
 */

import { describe, expect, it } from "vitest";
import {
	buildPendingAcceptanceLedger,
	evaluateAcceptance,
	formatAcceptancePrompt,
	normalizeAcceptanceInput,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	stripAcceptanceReport,
	validateAcceptanceInput,
	buildSkippedAcceptanceLedger,
	acceptanceFailureMessage,
} from "../extensions/acceptance.ts";
import type { ResolvedAcceptanceConfig } from "../extensions/types.ts";

/** Minimal valid ResolvedAcceptanceConfig for tests that don't inspect it. */
function makeEffectiveAcceptance(): ResolvedAcceptanceConfig {
	return { level: "attested", explicit: true, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] };
}

describe("acceptance", () => {
	describe("normalizeAcceptanceInput", () => {
		it("should return undefined for undefined input", () => {
			expect(normalizeAcceptanceInput(undefined)).toBeUndefined();
		});

		it("should handle false as disabled", () => {
			const result = normalizeAcceptanceInput(false);
			expect(result?.level).toBe("none");
			expect(result?.reason).toBe("Acceptance explicitly disabled.");
		});

		it("should handle level string", () => {
			expect(normalizeAcceptanceInput("verified")?.level).toBe("verified");
		});

		it("should throw for invalid level string", () => {
			expect(() => normalizeAcceptanceInput("invalid" as any)).toThrow();
		});

		it("should handle config object", () => {
			const result = normalizeAcceptanceInput({ level: "checked", criteria: ["test"] });
			expect(result?.level).toBe("checked");
			expect(result?.criteria).toEqual(["test"]);
		});

		it("should throw for non-object non-string input", () => {
			expect(() => normalizeAcceptanceInput(123 as any)).toThrow();
		});

		it("should throw for unknown config keys", () => {
			expect(() => normalizeAcceptanceInput({ unknown: true } as any)).toThrow();
		});
	});

	describe("validateAcceptanceInput", () => {
		it("should return empty for undefined", () => {
			expect(validateAcceptanceInput(undefined)).toEqual([]);
		});

		it("should return empty for false", () => {
			expect(validateAcceptanceInput(false)).toEqual([]);
		});

		it("should return empty for valid level string", () => {
			expect(validateAcceptanceInput("checked")).toEqual([]);
		});

		it("should return error for invalid level", () => {
			expect(validateAcceptanceInput("invalid")).toHaveLength(1);
		});

		it("should return error for non-string non-object", () => {
			expect(validateAcceptanceInput(123)).toHaveLength(1);
		});

		it("should validate evidence kinds", () => {
			const errors = validateAcceptanceInput({ evidence: ["invalid-evidence"] });
			expect(errors).toHaveLength(1);
		});

		it("should validate criteria", () => {
			const errors = validateAcceptanceInput({ criteria: [{ unknown: true }] });
			expect(errors.length).toBeGreaterThan(0);
		});

		it("should validate verify commands", () => {
			const errors = validateAcceptanceInput({ verify: [{ unknown: true }] });
			expect(errors.length).toBeGreaterThan(0);
		});
	});

	describe("resolveEffectiveAcceptance", () => {
		it("should use explicit level when provided", () => {
			const result = resolveEffectiveAcceptance({
				agentName: "worker",
				acceptance: "verified",
			});
			expect(result.level).toBe("verified");
			expect(result.explicit).toBe(true);
		});

		it("should infer none for read-only agents", () => {
			const result = resolveEffectiveAcceptance({
				agentName: "reviewer",
				acceptance: undefined,
			});
			expect(result.level).toBe("none");
		});

		it("should infer checked for writer agents", () => {
			const result = resolveEffectiveAcceptance({
				agentName: "worker",
				acceptance: undefined,
			});
			expect(result.level).toBe("checked");
		});

		it("should infer none for unknown agents", () => {
			const result = resolveEffectiveAcceptance({
				agentName: "custom-agent",
				acceptance: undefined,
			});
			expect(result.level).toBe("none");
		});
	});

	describe("formatAcceptancePrompt", () => {
		it("should format acceptance config", () => {
			const prompt = formatAcceptancePrompt({
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [{ id: "test", must: "All tests pass", evidence: ["tests-added"], severity: "required" }],
				evidence: ["changed-files", "tests-added"],
				verify: [{ id: "v1", command: "npm test" }],
				stopRules: [],
			});
			expect(prompt).toContain("## Acceptance");
			expect(prompt).toContain("checked");
			expect(prompt).toContain("All tests pass");
			expect(prompt).toContain("npm test");
		});

		it("should handle empty config", () => {
			const prompt = formatAcceptancePrompt({
				level: "none",
				explicit: true,
				inferredReason: [],
				criteria: [],
				evidence: [],
				verify: [],
				stopRules: [],
			});
			expect(prompt).toContain("## Acceptance");
			expect(prompt).toContain("none");
		});
	});

	describe("parseAcceptanceReport", () => {
		it("should parse valid report", () => {
			const output = "Some output\n---ACCEPTANCE_REPORT---\n{\"changedFiles\": [\"file.ts\"]}";
			const result = parseAcceptanceReport(output);
			expect(result.report).toBeDefined();
			expect(result.report?.changedFiles).toEqual(["file.ts"]);
		});

		it("should return empty for no marker", () => {
			const result = parseAcceptanceReport("Some output without marker");
			expect(result.report).toBeUndefined();
			expect(result.error).toBeUndefined();
		});

		it("should return error for invalid JSON", () => {
			const output = "---ACCEPTANCE_REPORT---\nnot json";
			const result = parseAcceptanceReport(output);
			expect(result.error).toBeDefined();
		});
	});

	describe("stripAcceptanceReport", () => {
		it("should strip report from output", () => {
			const output = "Some output\n---ACCEPTANCE_REPORT---\n{\"changedFiles\": []}";
			const result = stripAcceptanceReport(output);
			expect(result).toBe("Some output");
		});

		it("should return unchanged when no marker", () => {
			const output = "Some output without marker";
			expect(stripAcceptanceReport(output)).toBe(output);
		});
	});

	describe("buildPendingAcceptanceLedger", () => {
		it("should create pending ledger", () => {
			const ledger = buildPendingAcceptanceLedger({
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [],
				evidence: [],
				verify: [],
				stopRules: [],
			});
			expect(ledger.status).toBe("pending");
			expect(ledger.evidenceStatus).toBe("pending");
			expect(ledger.explicit).toBe(true);
		});
	});

	describe("buildSkippedAcceptanceLedger", () => {
		it("should create skipped ledger", () => {
			const ledger = buildSkippedAcceptanceLedger(
				{
					level: "none",
					explicit: true,
					inferredReason: [],
					criteria: [],
					evidence: [],
					verify: [],
					stopRules: [],
				},
				{ id: "test", message: "skipped" },
			);
			expect(ledger.status).toBe("not-required");
			expect(ledger.evidenceStatus).toBe("not-required");
		});
	});

	describe("acceptanceFailureMessage", () => {
		it("should return undefined for accepted", () => {
			const ledger = { status: "accepted" as const, evidenceStatus: "claimed" as const, explicit: true, effectiveAcceptance: makeEffectiveAcceptance(), inferredReason: [], criteria: [], runtimeChecks: [], verifyRuns: [] };
			expect(acceptanceFailureMessage(ledger)).toBeUndefined();
		});

		it("should return message for rejected", () => {
			const ledger = { status: "rejected" as const, evidenceStatus: "pending" as const, explicit: true, effectiveAcceptance: makeEffectiveAcceptance(), inferredReason: [], criteria: [], runtimeChecks: [], verifyRuns: [] };
			expect(acceptanceFailureMessage(ledger)).toBe("Acceptance was rejected.");
		});

		it("should return message for pending", () => {
			const ledger = { status: "pending" as const, evidenceStatus: "pending" as const, explicit: true, effectiveAcceptance: makeEffectiveAcceptance(), inferredReason: [], criteria: [], runtimeChecks: [], verifyRuns: [] };
			expect(acceptanceFailureMessage(ledger)).toContain("not met");
		});
	});

	describe("evaluateAcceptance", () => {
		it("should evaluate acceptance with no criteria", async () => {
			const result = await evaluateAcceptance({
				acceptance: {
					level: "none",
					explicit: true,
					inferredReason: [],
					criteria: [],
					evidence: [],
					verify: [],
					stopRules: [],
				},
				output: "Some output",
			});
			expect(result.status).toBe("accepted");
		});

		it("should parse acceptance report from output", async () => {
			const output = "Some output\n---ACCEPTANCE_REPORT---\n{\"criteriaSatisfied\": [{\"id\": \"test\", \"status\": \"satisfied\", \"evidence\": \"All tests pass\"}]}";
			const result = await evaluateAcceptance({
				acceptance: {
					level: "checked",
					explicit: true,
					inferredReason: [],
					criteria: [{ id: "test", must: "All tests pass", evidence: ["tests-added"], severity: "required" }],
					evidence: [],
					verify: [],
					stopRules: [],
				},
				output,
			});
			expect(result.childReport).toBeDefined();
			expect(result.childReport?.criteriaSatisfied?.[0].status).toBe("satisfied");
		});

		it("should reject when required criteria not met", async () => {
			const result = await evaluateAcceptance({
				acceptance: {
					level: "checked",
					explicit: true,
					inferredReason: [],
					criteria: [{ id: "missing", must: "Missing criteria", evidence: [], severity: "required" }],
					evidence: [],
					verify: [],
					stopRules: [],
				},
				output: "No report",
			});
			expect(result.status).toBe("rejected");
		});
	});
});
