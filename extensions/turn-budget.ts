/**
 * Turn budget enforcement — limits the number of assistant turns a child
 * subagent can take, with soft/hard thresholds and graceful wrap-up.
 */

import type { ResolvedTurnBudget, TurnBudgetState } from "./types.ts";

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1;

/**
 * Default turn budget applied to any subagent run (graph node or plain
 * `subagent` tool call) whose agent frontmatter declares none, and whose
 * project settings don't override it. Chosen to be generous — well above
 * any bundled agent's own budget — so it only bounds genuinely runaway
 * sessions, not normal ones. Agent frontmatter and project settings
 * (`defaultTurnBudget` in .pi-workflow/settings.json) both take precedence
 * over this; `defaultTurnBudget: null` in settings disables the default
 * entirely (agents with no frontmatter turnBudget run unbounded, as before
 * this feature existed).
 */
export const DEFAULT_TURN_BUDGET: ResolvedTurnBudget = { maxTurns: 50, graceTurns: 2 };

export function resolveTurnBudgetConfig(
	raw: unknown,
	label = "turnBudget",
): { turnBudget?: ResolvedTurnBudget; error?: string } {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `${label} must be an object with maxTurns and optional graceTurns.` };
	}
	const unknownField = Object.keys(raw).find((key) => key !== "maxTurns" && key !== "graceTurns");
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	const budget = raw as { maxTurns?: unknown; graceTurns?: unknown };
	if (typeof budget.maxTurns !== "number" || !Number.isInteger(budget.maxTurns) || budget.maxTurns < 1) {
		return { error: `${label}.maxTurns must be an integer >= 1.` };
	}
	const graceTurns = budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS;
	if (typeof graceTurns !== "number" || !Number.isInteger(graceTurns) || graceTurns < 0) {
		return { error: `${label}.graceTurns must be an integer >= 0.` };
	}
	return { turnBudget: { maxTurns: budget.maxTurns, graceTurns } };
}

export function appendTurnBudgetSystemPrompt(systemPrompt: string, budget: ResolvedTurnBudget | undefined): string {
	if (!budget) return systemPrompt;
	const grace = budget.graceTurns === 1 ? "1 additional assistant turn" : `${budget.graceTurns} additional assistant turns`;
	const block = [
		"## Turn budget",
		`This child run has a soft budget of ${budget.maxTurns} assistant turn${budget.maxTurns === 1 ? "" : "s"}.`,
		`After that, ${grace} may be allowed only for a final wrap-up.`,
		"When you approach or reach the soft budget, stop starting new tool work and return the final answer immediately.",
		"This runner uses process-mode execution, so live steering after launch may be unavailable; treat this instruction as the wrap-up request.",
		"If you continue past the soft budget plus grace turns, the supervisor may abort the process and return only partial output.",
	].join("\n");
	return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${block}` : block;
}

export function turnBudgetSoftNote(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Turn budget wrap-up was requested after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns}, grace ${budget.graceTurns}). Process-mode live steering is unavailable, so the child was warned at launch to wrap up by this budget. Output may be partial.`;
}

export function turnBudgetExceededMessage(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Subagent exceeded turn budget after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}).`;
}

export function turnBudgetDeferredNote(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Turn-budget termination was deferred at ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}) because the assistant started tool work. The run ended before another safe assistant boundary; output may be partial.`;
}

export function formatTurnBudgetOutput(message: string, output: string): string {
	return output.trim()
		? `${message}\n\nPartial output before turn-budget abort:\n${output}`
		: message;
}

export function initialTurnBudgetState(budget: ResolvedTurnBudget): TurnBudgetState {
	return { ...budget, outcome: "within-budget", turnCount: 0 };
}

export function turnBudgetState(budget: ResolvedTurnBudget, turnCount: number, exceeded: boolean): TurnBudgetState {
	const hardLimit = budget.maxTurns + budget.graceTurns;
	if (turnCount < budget.maxTurns) {
		return {
			...budget,
			turnCount,
			outcome: "within-budget",
		};
	}
	if (turnCount < hardLimit) {
		return {
			...budget,
			turnCount,
			outcome: "wrap-up-requested",
			wrapUpRequestedAtTurn: budget.maxTurns,
		};
	}
	return {
		...budget,
		turnCount,
		outcome: exceeded ? "exceeded" : "wrap-up-requested",
		wrapUpRequestedAtTurn: budget.maxTurns,
		...(exceeded ? { exceededAtTurn: turnCount } : {}),
	};
}

export function turnBudgetDeferredState(
	budget: ResolvedTurnBudget,
	turnCount: number,
	terminationDeferredAtTurn = turnCount,
): TurnBudgetState {
	return {
		...budget,
		turnCount,
		outcome: "termination-deferred",
		wrapUpRequestedAtTurn: budget.maxTurns,
		terminationDeferredAtTurn,
	};
}

export function turnBudgetDecision(
	budget: ResolvedTurnBudget,
	turnCount: number,
	terminalAssistantStop: boolean,
	toolWorkActiveOrStarting: boolean,
	enforceHardLimit = false,
): "continue" | "defer" | "abort" {
	const hardLimit = budget.maxTurns + budget.graceTurns;
	if (turnCount < hardLimit) return "continue";
	if (toolWorkActiveOrStarting && !enforceHardLimit) return "defer";
	if (turnCount === hardLimit && terminalAssistantStop) return "continue";
	return "abort";
}

/** Env var carrying a JSON-encoded ResolvedTurnBudget to a spawned child, mirroring tool-budget.ts's TOOL_BUDGET_ENV. */
export const TURN_BUDGET_ENV = "PI_SUBAGENT_TURN_BUDGET";

export function encodeTurnBudgetEnv(budget: ResolvedTurnBudget | undefined): string | undefined {
	return budget ? JSON.stringify(budget) : undefined;
}

export function decodeTurnBudgetEnv(value: string | undefined): ResolvedTurnBudget | undefined {
	if (!value?.trim()) return undefined;
	const parsed = JSON.parse(value) as unknown;
	const normalized = resolveTurnBudgetConfig(parsed, TURN_BUDGET_ENV);
	if (normalized.error) throw new Error(normalized.error);
	return normalized.turnBudget;
}

/**
 * Message injected (as a blocking tool_call reason) once the child reaches
 * maxTurns via the child-side soft-block mechanism. Mirrors
 * toolBudgetBlockedMessage's shape and intent: the model sees an ordinary
 * tool-call-blocked reason, not a kill, and can wrap up normally with real
 * output. The hard parent-side kill at maxTurns + graceTurns remains only
 * as a backstop for a model that ignores this and keeps calling tools.
 */
export function turnBudgetSoftBlockMessage(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Turn budget reached after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (limit ${budget.maxTurns}). Tool calls are now blocked — stop working and produce your final answer now, using the context you already have. No further tool calls will be allowed.`;
}
