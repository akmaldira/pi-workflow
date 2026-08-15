/**
 * Blank-stop guard: when a model returns a "successful" empty completion
 * (content: [], usage.output: 0, stopReason: "stop" — observed from Gemini
 * Flash tiers via proxies, in both the main agent and subagents), the guard
 * sends a visible "continue" user message, exactly as the user does by hand.
 *
 * Two layers of tests:
 * 1. Predicate units — the exact observed failure shape matches, and every
 *    near-miss shape (text present, tool call present, output tokens,
 *    error/aborted/length stops, non-assistant roles) is rejected.
 * 2. Guard behavior via a mock pi — blank turn + agent_end sends
 *    "continue" with deliverAs: "followUp"; the consecutive-blank counter
 *    resets on any real turn; at most MAX_CONSECUTIVE_BLANK_CONTINUES
 *    sends; a sendUserMessage failure degrades silently.
 */

import { describe, expect, it, vi } from "vitest";
import {
	BLANK_STOP_CONTINUE_MESSAGE,
	MAX_CONSECUTIVE_BLANK_CONTINUES,
	isBlankStop,
	isThinkingOnlyStop,
	registerBlankStopGuard,
} from "../extensions/blank-stop-guard.ts";

/** The exact production failure shape from the investigated log entry. */
const OBSERVED_BLANK = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "9router",
	model: "erica-flash",
	usage: { input: 7414, output: 0, cacheRead: 16304, cacheWrite: 0, reasoning: 0, totalTokens: 23718 },
	stopReason: "stop",
	rawStopReason: "stop",
};

/** The exact thinking-only failure shape from the reviewer-stall report. */
const OBSERVED_THINKING_ONLY = {
	role: "assistant",
	content: [
		{
			type: "thinking",
			thinking:
				"**Analyzing API Interaction**\n\nI've initiated an API call to read a specific file, \"simple.md,\" associated with an OCR result. My current focus is validating the initial connection and the request parameters.",
			thinkingSignature: "reasoning",
		},
	],
	api: "openai-completions",
	provider: "9router",
	model: "erica-flash",
	usage: { input: 4723, output: 47, cacheRead: 57065, cacheWrite: 0, reasoning: 47, totalTokens: 61835 },
	stopReason: "stop",
	rawStopReason: "stop",
};

describe("isBlankStop", () => {
	it("matches the exact observed production shape", () => {
		expect(isBlankStop(OBSERVED_BLANK)).toBe(true);
	});

	it("matches whitespace-only text as blank", () => {
		expect(isBlankStop({ role: "assistant", content: [{ type: "text", text: "   \n  " }], stopReason: "stop", usage: { output: 0 } })).toBe(true);
	});

	it("matches a plain empty string content", () => {
		expect(isBlankStop({ role: "assistant", content: "", stopReason: "stop", usage: { output: 0 } })).toBe(true);
	});

	it("rejects any non-empty text", () => {
		expect(isBlankStop({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { output: 5 } })).toBe(false);
	});

	it("rejects a tool-call turn even with zero output tokens", () => {
		// Defensive: a turn that emitted a tool call has not "ended blank" —
		// the loop is mid-run. (In practice tool calls burn output tokens.)
		expect(isBlankStop({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "stop", usage: { output: 0 } })).toBe(false);
	});

	it("rejects any turn with output tokens (thinking, narration, tool args)", () => {
		expect(isBlankStop({ role: "assistant", content: [], stopReason: "stop", usage: { output: 1 } })).toBe(false);
		expect(isBlankStop({ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop", usage: { output: 3 } })).toBe(false);
	});

	it("rejects non-stop stop reasons — those are handled elsewhere", () => {
		for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
			expect(isBlankStop({ role: "assistant", content: [], stopReason, usage: { output: 0 } })).toBe(false);
		}
	});

	it("rejects non-assistant roles and missing messages", () => {
		expect(isBlankStop({ role: "user", content: "hello" })).toBe(false);
		expect(isBlankStop(undefined)).toBe(false);
		expect(isBlankStop(null)).toBe(false);
	});
});

describe("isThinkingOnlyStop", () => {
	it("matches the exact observed production shape (output tokens > 0)", () => {
		expect(isThinkingOnlyStop(OBSERVED_THINKING_ONLY)).toBe(true);
	});

	it("matches with zero output tokens too — the shape is structural, not usage-based", () => {
		expect(isThinkingOnlyStop({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], stopReason: "stop", usage: { output: 0 } })).toBe(true);
	});

	it("matches multiple thinking blocks", () => {
		expect(
			isThinkingOnlyStop({
				role: "assistant",
				content: [
				{ type: "thinking", thinking: "part one" },
				{ type: "thinking", thinking: "part two" },
			],
				stopReason: "stop",
				usage: { output: 99 },
			}),
		).toBe(true);
	});

	it("rejects thinking + text — a real answer with visible reasoning", () => {
		expect(
			isThinkingOnlyStop({
				role: "assistant",
				content: [
				{ type: "thinking", thinking: "let me think" },
				{ type: "text", text: "The answer is 42." },
			],
				stopReason: "stop",
				usage: { output: 50 },
			}),
		).toBe(false);
	});

	it("rejects thinking + toolCall — a mid-run turn, not an ending", () => {
		expect(
			isThinkingOnlyStop({
				role: "assistant",
				content: [
				{ type: "thinking", thinking: "I should read the file" },
				{ type: "toolCall" },
			],
				stopReason: "stop",
				usage: { output: 30 },
			}),
		).toBe(false);
	});

	it("rejects whitespace-only thinking — not the observed shape", () => {
		expect(isThinkingOnlyStop({ role: "assistant", content: [{ type: "thinking", thinking: "   " }], stopReason: "stop", usage: { output: 5 } })).toBe(false);
	});

	it("rejects empty content with output tokens — neither the blank nor the thinking-only shape", () => {
		// Billed-but-empty with no thinking block at all: outside both
		// predicates by design (don't guess beyond the evidence).
		expect(isThinkingOnlyStop({ role: "assistant", content: [], stopReason: "stop", usage: { output: 7 } })).toBe(false);
		expect(isBlankStop({ role: "assistant", content: [], stopReason: "stop", usage: { output: 7 } })).toBe(false);
	});

	it("rejects non-stop stop reasons and non-assistant roles", () => {
		for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
			expect(isThinkingOnlyStop({ role: "assistant", content: [{ type: "thinking", thinking: "x" }], stopReason, usage: { output: 5 } })).toBe(false);
		}
		expect(isThinkingOnlyStop({ role: "user", content: "hello" })).toBe(false);
		expect(isThinkingOnlyStop(undefined)).toBe(false);
	});
});

/** Minimal pi stub capturing hook registrations and sendUserMessage calls. */
function makePi() {
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	const sendCalls: Array<{ content: string; options?: { deliverAs?: string } }> = [];
	return {
		on(event: string, handler: (event: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		emit(event: string, payload: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
		sendUserMessage(content: string, options?: { deliverAs?: string }) {
			sendCalls.push({ content, options });
		},
		sendCalls,
	};
}

const turnEnd = (message: unknown) => ({ type: "turn_end", turnIndex: 0, message, toolResults: [] });
const agentEnd = () => ({ type: "agent_end", messages: [] });

describe("registerBlankStopGuard", () => {
	it("sends a visible 'continue' as followUp when the run ends on a blank turn", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(1);
		expect(pi.sendCalls[0].content).toBe(BLANK_STOP_CONTINUE_MESSAGE);
		expect(pi.sendCalls[0].content).toBe("continue");
		// followUp is load-bearing: during an agent_end handler pi still
		// reports itself streaming, so a bare sendUserMessage throws.
		expect(pi.sendCalls[0].options?.deliverAs).toBe("followUp");
	});

	it("sends a visible 'continue' as followUp when the run ends on a thinking-only turn", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		pi.emit("turn_end", turnEnd(OBSERVED_THINKING_ONLY));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(1);
		expect(pi.sendCalls[0].content).toBe("continue");
		expect(pi.sendCalls[0].options?.deliverAs).toBe("followUp");
	});

	it("shares one nudge budget across blank and thinking-only stalls", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		// Alternating stall shapes: still one shared budget of 3.
		const stalls = [OBSERVED_BLANK, OBSERVED_THINKING_ONLY, OBSERVED_BLANK, OBSERVED_THINKING_ONLY, OBSERVED_BLANK, OBSERVED_THINKING_ONLY];
		for (const stall of stalls) {
			pi.emit("turn_end", turnEnd(stall));
		pi.emit("agent_end", agentEnd());
		}

		expect(pi.sendCalls.length).toBe(MAX_CONSECUTIVE_BLANK_CONTINUES);
	});

	it("sends nothing for a healthy run", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		pi.emit("turn_end", turnEnd({ role: "assistant", content: [{ type: "text", text: "all done" }], stopReason: "stop", usage: { output: 12 } }));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(0);
	});

	it("sends nothing when a real turn follows the blank one", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("turn_end", turnEnd({ role: "assistant", content: [{ type: "text", text: "resumed" }], stopReason: "stop", usage: { output: 8 } }));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(0);
	});

	it("sends nothing when a thinking+text turn follows a thinking-only stall", () => {
		// The recovery path in real life: the nudge lands, the model answers
		// with reasoning AND text. That healthy turn must clear the flag so a
		// later agent_end does not fire a stale nudge.
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		pi.emit("turn_end", turnEnd(OBSERVED_THINKING_ONLY));
		pi.emit("turn_end", turnEnd({ role: "assistant", content: [{ type: "thinking", thinking: "now I know" }, { type: "text", text: "recovered" }], stopReason: "stop", usage: { output: 20 } }));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(0);
	});

	it("resets the budget after any real turn", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		// A blank recovered by a manual real turn (counter reset)...
		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("turn_end", turnEnd({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { output: 4 } }));
		// ...then a later blank in the same process still gets the full
		// retry budget.
		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(1);
	});

	it("sends at most MAX_CONSECUTIVE_BLANK_CONTINUES times for a persistently blank model", () => {
		expect(MAX_CONSECUTIVE_BLANK_CONTINUES).toBe(3);
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		// Each continuation is a new agent loop: blank turn_end, agent_end
		// (guard sends), model goes blank again, repeat.
		for (let round = 0; round < 6; round++) {
			pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
			pi.emit("agent_end", agentEnd());
		}

		expect(pi.sendCalls.length).toBe(MAX_CONSECUTIVE_BLANK_CONTINUES);
		// And every send was the same nudge.
		expect(pi.sendCalls.every((c) => c.content === "continue" && c.options?.deliverAs === "followUp")).toBe(true);
	});

	it("does not double-send when agent_end fires without a preceding blank turn", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never);

		// Blank mid-run (e.g. pi's own machinery continues), then healthy
		// agent_end: the guard must not latch onto the stale blank.
		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("turn_end", turnEnd({ role: "assistant", content: [{ type: "text", text: "fine now" }], stopReason: "stop", usage: { output: 2 } }));
		pi.emit("agent_end", agentEnd());
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(0);
	});

	it("degrades silently if sendUserMessage throws", () => {
		const pi = makePi();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		pi.sendUserMessage = () => {
			throw new Error("Agent is already processing");
		};
		registerBlankStopGuard(pi as never);

		expect(() => {
			pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
			pi.emit("agent_end", agentEnd());
		}).not.toThrow();
		expect(errorSpy).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});

	it("registers no hooks and sends nothing when enabled: false", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never, { enabled: false });

		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("agent_end", agentEnd());

		// The blank result flows out untouched — exactly the pre-guard
		// behaviour, as if the guard had never existed in this process.
		expect(pi.sendCalls.length).toBe(0);
	});

	it("defaults to enabled when options or options.enabled are omitted", () => {
		const pi = makePi();
		registerBlankStopGuard(pi as never, {});

		pi.emit("turn_end", turnEnd(OBSERVED_BLANK));
		pi.emit("agent_end", agentEnd());

		expect(pi.sendCalls.length).toBe(1);
	});
});
