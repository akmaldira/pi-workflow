/**
 * Tests for turn-budget.ts — Turn budget enforcement
 */

import { describe, expect, it } from "vitest";
import {
	appendTurnBudgetSystemPrompt,
	formatTurnBudgetOutput,
	initialTurnBudgetState,
	resolveTurnBudgetConfig,
	turnBudgetDecision,
	turnBudgetDeferredNote,
	turnBudgetDeferredState,
	turnBudgetExceededMessage,
	turnBudgetSoftNote,
	turnBudgetState,
} from "../extensions/turn-budget.ts";

describe("turn-budget", () => {
	describe("resolveTurnBudgetConfig", () => {
		it("should return empty for undefined", () => {
			expect(resolveTurnBudgetConfig(undefined)).toEqual({});
		});

		it("should parse valid config", () => {
			const result = resolveTurnBudgetConfig({ maxTurns: 10, graceTurns: 2 });
			expect(result.turnBudget).toEqual({ maxTurns: 10, graceTurns: 2 });
		});

		it("should use default graceTurns when not specified", () => {
			const result = resolveTurnBudgetConfig({ maxTurns: 10 });
			expect(result.turnBudget?.graceTurns).toBe(1);
		});

		it("should error for maxTurns < 1", () => {
			expect(resolveTurnBudgetConfig({ maxTurns: 0 })).toHaveProperty("error");
		});

		it("should error for negative graceTurns", () => {
			expect(resolveTurnBudgetConfig({ maxTurns: 10, graceTurns: -1 })).toHaveProperty("error");
		});

		it("should error for unknown fields", () => {
			expect(resolveTurnBudgetConfig({ maxTurns: 10, unknown: true })).toHaveProperty("error");
		});
	});

	describe("appendTurnBudgetSystemPrompt", () => {
		it("should return unchanged prompt when no budget", () => {
			expect(appendTurnBudgetSystemPrompt("Hello", undefined)).toBe("Hello");
		});

		it("should append budget block to existing prompt", () => {
			const result = appendTurnBudgetSystemPrompt("Hello", { maxTurns: 10, graceTurns: 2 });
			expect(result).toContain("Hello");
			expect(result).toContain("## Turn budget");
			expect(result).toContain("10");
			expect(result).toContain("2 additional");
		});

		it("should use singular form for 1 grace turn", () => {
			const result = appendTurnBudgetSystemPrompt("", { maxTurns: 10, graceTurns: 1 });
			expect(result).toContain("1 additional assistant turn");
		});

		it("should use plural form for multiple grace turns", () => {
			const result = appendTurnBudgetSystemPrompt("", { maxTurns: 10, graceTurns: 3 });
			expect(result).toContain("3 additional assistant turns");
		});
	});

	describe("initialTurnBudgetState", () => {
		it("should create initial state", () => {
			const state = initialTurnBudgetState({ maxTurns: 10, graceTurns: 2 });
			expect(state.turnCount).toBe(0);
			expect(state.outcome).toBe("within-budget");
		});
	});

	describe("turnBudgetState", () => {
		const budget = { maxTurns: 10, graceTurns: 2 };

		it("should return within-budget when under limit", () => {
			const state = turnBudgetState(budget, 5, false);
			expect(state.outcome).toBe("within-budget");
		});

		it("should return wrap-up-requested when exceeded", () => {
			const state = turnBudgetState(budget, 13, true);
			expect(state.outcome).toBe("exceeded");
			expect(state.exceededAtTurn).toBe(13);
		});

		it("should return wrap-up-requested when not exceeded", () => {
			const state = turnBudgetState(budget, 13, false);
			expect(state.outcome).toBe("wrap-up-requested");
			expect(state.wrapUpRequestedAtTurn).toBe(10);
		});
	});

	describe("turnBudgetDeferredState", () => {
		it("should create deferred state", () => {
			const state = turnBudgetDeferredState({ maxTurns: 10, graceTurns: 2 }, 13);
			expect(state.outcome).toBe("termination-deferred");
			expect(state.wrapUpRequestedAtTurn).toBe(10);
			expect(state.terminationDeferredAtTurn).toBe(13);
		});
	});

	describe("turnBudgetDecision", () => {
		const budget = { maxTurns: 10, graceTurns: 2 };

		it("should continue when under hard limit", () => {
			expect(turnBudgetDecision(budget, 5, false, false)).toBe("continue");
		});

		it("should continue at hard limit with terminal assistant stop", () => {
			expect(turnBudgetDecision(budget, 12, true, false)).toBe("continue");
		});

		it("should defer when over hard limit with tool work", () => {
			expect(turnBudgetDecision(budget, 13, false, true)).toBe("defer");
		});

		it("should abort when over hard limit without tool work", () => {
			expect(turnBudgetDecision(budget, 13, false, false)).toBe("abort");
		});

		it("should abort when over hard limit with enforceHardLimit", () => {
			expect(turnBudgetDecision(budget, 13, false, true, true)).toBe("abort");
		});
	});

	describe("formatTurnBudgetOutput", () => {
		it("should prepend message to output", () => {
			const result = formatTurnBudgetOutput("Budget exceeded", "Some output");
			expect(result).toContain("Budget exceeded");
			expect(result).toContain("Some output");
		});

		it("should handle empty output", () => {
			const result = formatTurnBudgetOutput("Budget exceeded", "");
			expect(result).toBe("Budget exceeded");
		});
	});

	describe("turnBudgetSoftNote", () => {
		it("should generate soft note", () => {
			const note = turnBudgetSoftNote({ maxTurns: 10, graceTurns: 2 }, 10);
			expect(note).toContain("10");
			expect(note).toContain("soft limit 10");
			expect(note).toContain("grace 2");
		});
	});

	describe("turnBudgetExceededMessage", () => {
		it("should generate exceeded message", () => {
			const msg = turnBudgetExceededMessage({ maxTurns: 10, graceTurns: 2 }, 13);
			expect(msg).toContain("13");
			expect(msg).toContain("10");
			expect(msg).toContain("2");
		});
	});

	describe("turnBudgetDeferredNote", () => {
		it("should generate deferred note", () => {
			const note = turnBudgetDeferredNote({ maxTurns: 10, graceTurns: 2 }, 13);
			expect(note).toContain("13");
			expect(note).toContain("10");
			expect(note).toContain("2");
		});
	});
});
