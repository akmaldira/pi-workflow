/**
 * Child-side budget enforcement in subagent-prompt-runtime.ts:
 * registerToolBudget (pre-existing, previously untested) and
 * registerTurnBudget (new — mirrors the tool-budget pattern: block tools
 * once a limit is reached so the model wraps up normally with real output,
 * instead of being killed).
 */

import { describe, expect, it, vi } from "vitest";
import { registerToolBudget, registerTurnBudget } from "../extensions/subagent-prompt-runtime.ts";
import type { ResolvedToolBudget, ResolvedTurnBudget } from "../extensions/types.ts";

function makeFakePi() {
	const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
	const sendUserMessage = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: (e: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		}),
		sendUserMessage,
	};
	return { pi: pi as unknown as Parameters<typeof registerTurnBudget>[0], handlers, sendUserMessage };
}

function turnEnd(turnIndex: number) {
	return { type: "turn_end", turnIndex, message: { role: "assistant" }, toolResults: [] };
}

function toolCall(toolName = "bash") {
	return { type: "tool_call", toolCallId: "tc-1", toolName, input: {} };
}

describe("registerTurnBudget", () => {
	const budget: ResolvedTurnBudget = { maxTurns: 3, graceTurns: 1 };

	it("does nothing when budget is undefined", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, undefined);
		expect(handlers["turn_end"]).toBeUndefined();
		expect(handlers["tool_call"]).toBeUndefined();
	});

	it("does not block tool calls before maxTurns is reached", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, budget);
		handlers["turn_end"]![0](turnEnd(0)); // 1 turn completed
		handlers["turn_end"]![0](turnEnd(1)); // 2 turns completed
		const result = handlers["tool_call"]![0](toolCall());
		expect(result).toBeUndefined();
	});

	it("blocks tool calls once turnsCompleted reaches maxTurns", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, budget);
		handlers["turn_end"]![0](turnEnd(0));
		handlers["turn_end"]![0](turnEnd(1));
		handlers["turn_end"]![0](turnEnd(2)); // 3 turns completed == maxTurns
		const result = handlers["tool_call"]![0](toolCall("bash")) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Turn budget reached");
		expect(result.reason).toContain("3");
	});

	it("keeps blocking every subsequent tool call once past maxTurns (does not un-block)", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, budget);
		for (let i = 0; i < 5; i++) handlers["turn_end"]![0](turnEnd(i));
		const first = handlers["tool_call"]![0](toolCall("read")) as { block: boolean };
		const second = handlers["tool_call"]![0](toolCall("bash")) as { block: boolean };
		expect(first.block).toBe(true);
		expect(second.block).toBe(true);
	});

	it("blocks regardless of which tool is called (unlike tool-budget's configurable block list)", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, budget);
		for (let i = 0; i < 3; i++) handlers["turn_end"]![0](turnEnd(i));
		const result = handlers["tool_call"]![0](toolCall("structured_output")) as { block: boolean };
		expect(result.block).toBe(true);
	});

	it("ignores turn_end events with a non-number turnIndex", () => {
		const { pi, handlers } = makeFakePi();
		registerTurnBudget(pi, budget);
		handlers["turn_end"]![0]({ type: "turn_end" }); // no turnIndex
		const result = handlers["tool_call"]![0](toolCall());
		expect(result).toBeUndefined();
	});
});

describe("registerToolBudget (pre-existing, gaining coverage alongside the turn-budget addition)", () => {
	const budget: ResolvedToolBudget = { hard: 3, soft: 2, block: "*" };

	it("does nothing when budget is undefined", () => {
		const { pi, handlers } = makeFakePi();
		registerToolBudget(pi, undefined);
		expect(handlers["tool_call"]).toBeUndefined();
	});

	it("sends a soft nudge once the soft threshold is reached, then blocks once past hard", () => {
		const { pi, handlers, sendUserMessage } = makeFakePi();
		registerToolBudget(pi, budget); // hard: 3, soft: 2 — shouldBlockToolForBudget blocks when count > hard
		expect(handlers["tool_call"]![0](toolCall("read"))).toBeUndefined(); // 1
		expect(handlers["tool_call"]![0](toolCall("read"))).toBeUndefined(); // 2 -> soft nudge fires, not blocked yet
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("soft limit"), { deliverAs: "steer" });
		expect(handlers["tool_call"]![0](toolCall("read"))).toBeUndefined(); // 3 == hard, still not blocked
		const blocked = handlers["tool_call"]![0](toolCall("read")) as { block: boolean; reason: string }; // 4 > hard -> blocked
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("hard limit");
	});

	it("only sends the soft nudge once even if more calls land at/above soft before hard", () => {
		const { pi, handlers, sendUserMessage } = makeFakePi();
		registerToolBudget(pi, { hard: 5, soft: 1, block: "*" });
		handlers["tool_call"]![0](toolCall("read"));
		handlers["tool_call"]![0](toolCall("read"));
		handlers["tool_call"]![0](toolCall("read"));
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("only blocks tools in the configured block list when block is not '*'", () => {
		const { pi, handlers } = makeFakePi();
		registerToolBudget(pi, { hard: 1, block: ["read", "grep"] });
		handlers["tool_call"]![0](toolCall("bash")); // 1 -> over hard, but bash isn't in block list
		const bashResult = handlers["tool_call"]![0](toolCall("bash"));
		expect(bashResult).toBeUndefined();
	});

	it("swallows a throwing sendUserMessage without breaking the block decision", () => {
		const { pi, handlers } = makeFakePi();
		(pi as unknown as { sendUserMessage: () => void }).sendUserMessage = () => {
			throw new Error("boom");
		};
		registerToolBudget(pi, { hard: 0, soft: 1, block: "*" });
		const result = handlers["tool_call"]![0](toolCall("read")) as { block: boolean };
		expect(result.block).toBe(true);
	});
});
