/**
 * Tests for tool-budget.ts — Tool call budget enforcement
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOOL_BUDGET_BLOCK,
	encodeToolBudgetEnv,
	decodeToolBudgetEnv,
	initialToolBudgetState,
	normalizeToolBudgetBlock,
	shouldBlockToolForBudget,
	toolBudgetBlockedMessage,
	toolBudgetSoftNudge,
	toolBudgetState,
	validateToolBudgetConfig,
} from "../extensions/tool-budget.ts";

describe("tool-budget", () => {
	describe("normalizeToolBudgetBlock", () => {
		it("should return default block when undefined", () => {
			expect(normalizeToolBudgetBlock(undefined)).toEqual(["read", "grep", "find", "ls"]);
		});

		it("should return '*' for '*' input", () => {
			expect(normalizeToolBudgetBlock("*")).toBe("*");
		});

		it("should deduplicate and filter empty strings", () => {
			expect(normalizeToolBudgetBlock(["read", "", "read", "write"])).toEqual(["read", "write"]);
		});
	});

	describe("validateToolBudgetConfig", () => {
		it("should return empty for undefined", () => {
			expect(validateToolBudgetConfig(undefined)).toEqual({});
		});

		it("should validate valid config", () => {
			const result = validateToolBudgetConfig({ hard: 50, soft: 30, block: ["read"] });
			expect(result.budget).toEqual({ hard: 50, soft: 30, block: ["read"] });
		});

		it("should use default block when not specified", () => {
			const result = validateToolBudgetConfig({ hard: 50 });
			expect(result.budget?.block).toEqual(["read", "grep", "find", "ls"]);
		});

		it("should error when hard < 1", () => {
			expect(validateToolBudgetConfig({ hard: 0 })).toHaveProperty("error");
		});

		it("should error when soft > hard", () => {
			expect(validateToolBudgetConfig({ hard: 10, soft: 20 })).toHaveProperty("error");
		});

		it("should error when block is empty array", () => {
			expect(validateToolBudgetConfig({ hard: 10, block: [] })).toHaveProperty("error");
		});

		it("should error when block is not array or *", () => {
			expect(validateToolBudgetConfig({ hard: 10, block: "read" })).toHaveProperty("error");
		});

		it("should allow minimumHard=0", () => {
			const result = validateToolBudgetConfig({ hard: 0 }, "test", { minimumHard: 0 });
			expect(result.budget).toEqual({ hard: 0, block: ["read", "grep", "find", "ls"] });
		});
	});

	describe("initialToolBudgetState", () => {
		it("should create initial state", () => {
			const state = initialToolBudgetState({ hard: 50, block: ["read"] });
			expect(state.toolCount).toBe(0);
			expect(state.outcome).toBe("within-budget");
			expect(state.hard).toBe(50);
		});
	});

	describe("toolBudgetState", () => {
		const budget = { hard: 50, soft: 30, block: ["read"] as const };

		it("should return within-budget when under soft limit", () => {
			const state = toolBudgetState(budget, 10);
			expect(state.outcome).toBe("within-budget");
		});

		it("should return soft-reached when at soft limit", () => {
			const state = toolBudgetState(budget, 30);
			expect(state.outcome).toBe("soft-reached");
			expect(state.softReachedAt).toBe(30);
		});

		it("should return hard-blocked when over hard limit", () => {
			const state = toolBudgetState(budget, 51, "read");
			expect(state.outcome).toBe("hard-blocked");
			expect(state.hardReachedAt).toBe(50);
			expect(state.blockedTool).toBe("read");
		});
	});

	describe("shouldBlockToolForBudget", () => {
		const budget = { hard: 10, block: ["read"] as const };

		it("should not block when under hard limit", () => {
			expect(shouldBlockToolForBudget(budget, "read", 10)).toBe(false);
		});

		it("should not block when at hard limit", () => {
			expect(shouldBlockToolForBudget(budget, "read", 11)).toBe(true);
		});

		it("should block specified tool when over limit", () => {
			expect(shouldBlockToolForBudget(budget, "read", 11)).toBe(true);
		});

		it("should not block non-blocked tool when over limit", () => {
			const budgetWithStar = { hard: 10, block: "*" as const };
			expect(shouldBlockToolForBudget(budgetWithStar, "bash", 11)).toBe(true);
		});
	});

	describe("encode/decodeToolBudgetEnv", () => {
		it("should encode and decode round-trip", () => {
			const budget = { hard: 50, soft: 30, block: ["read"] as const };
			const encoded = encodeToolBudgetEnv(budget);
			expect(encoded).toBeDefined();
			const decoded = decodeToolBudgetEnv(encoded!);
			expect(decoded).toEqual(budget);
		});

		it("should return undefined for undefined budget", () => {
			expect(encodeToolBudgetEnv(undefined)).toBeUndefined();
		});

		it("should return undefined for empty string", () => {
			expect(decodeToolBudgetEnv("")).toBeUndefined();
		});

		it("should throw for invalid JSON", () => {
			expect(() => decodeToolBudgetEnv("invalid")).toThrow();
		});
	});

	describe("toolBudgetSoftNudge", () => {
		it("should generate nudge message", () => {
			const budget = { hard: 50, soft: 30, block: ["read"] as const };
			const msg = toolBudgetSoftNudge(budget, 30);
			expect(msg).toContain("30");
			expect(msg).toContain("soft 30");
			expect(msg).toContain("hard 50");
		});
	});

	describe("toolBudgetBlockedMessage", () => {
		it("should generate blocked message", () => {
			const budget = { hard: 50, soft: 30, block: ["read"] as const };
			const msg = toolBudgetBlockedMessage(budget, "read", 51);
			expect(msg).toContain("read");
			expect(msg).toContain("51");
			expect(msg).toContain("hard 50");
		});
	});
});
