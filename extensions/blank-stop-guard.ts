/**
 * Blank-stop guard: auto-"continue" when a model returns a genuinely empty
 * or thinking-only completion.
 *
 * Some models (notably Gemini Flash tiers via proxies) occasionally emit a
 * "successful" turn that contains nothing usable. Two observed shapes:
 *
 * 1. Blank: content: [], usage.output: 0, stopReason: "stop".
 * 2. Thinking-only: content: [thinking block(s), no text, no tool calls],
 *    usage.output > 0 (thinking burns output tokens), stopReason: "stop".
 *    Observed from erica-flash: reasoning streams, then the model just
 *    stops without ever emitting an answer.
 *
 * pi-coding-agent treats both as clean completions — its auto-retry only
 * fires on stopReason "error", so these shapes fall through every built-in
 * safety net and surface as an empty agent reply. Observed in both the main
 * interactive agent and spawned subagents.
 *
 * The fix is what the user does by hand in this situation: send "continue"
 * as a visible user message. pi-coding-agent has first-class support for
 * exactly this: messages queued by an agent_end extension handler are
 * drained into a continuation of the same run (see agent-session.js
 * _handlePostAgentRun → hasQueuedMessages → agent.continue()), so the
 * model resumes with its full context intact.
 *
 * Registered once per pi process; because pi-workflow injects its own
 * extension path into every spawned child (pi-args.ts runtimeExtensions),
 * the guard covers the main agent, every subagent, and nested levels.
 *
 * Safety: bounded at MAX_CONSECUTIVE_BLANK_CONTINUES consecutive sends per
 * process; the counter resets the moment any turn produces real content
 * (any text or tool call — usage.output alone does not count, because a
 * thinking-only stop burns output tokens too), so a long-lived session
 * always has its full retry budget available again after a healthy turn.
 * If the model stays stalled after 3 nudges, the guard stays silent and the
 * empty result flows out exactly as before this guard existed (workflow-level
 * backstops like retry edges remain the last line of defense).
 */

import type { AgentEndEvent, ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";

/** Max consecutive "continue" nudges before giving up on a stuck-blank model. */
export const MAX_CONSECUTIVE_BLANK_CONTINUES = 3;

/** The nudge text — identical to what the user types manually in this case. */
export const BLANK_STOP_CONTINUE_MESSAGE = "continue";

/**
 * Minimal assistant-message shape the predicate needs. Kept structural
 * (no import from pi-protocol) so tests can construct plain objects and
 * the guard stays decoupled from upstream type churn.
 */
interface AssistantMessageLike {
	role?: string;
	content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
	stopReason?: string;
	usage?: { output?: number };
}

/**
 * True when a completed assistant message is the blank-stop failure shape:
 * a "successful" stop with zero generated tokens and no content at all.
 *
 * Deliberately strict, matching the observed production failure exactly
 * (content: [], output: 0, reasoning: 0, stopReason: "stop"):
 * - stopReason must be "stop" — "error" is handled by pi's auto-retry,
 *   "aborted" by user cancellation, "length" by truncation handling.
 * - no text part with non-empty text (content: [] is the degenerate case).
 * - no tool-call parts, so the turn genuinely ended rather than pausing
 *   mid-tool-run.
 * - usage.output === 0 — the false-positive killer: text, thinking, and
 *   tool-call arguments all burn output tokens, so any turn where the
 *   model did anything at all is excluded. There is no legitimate way to
 *   complete a turn with zero generated tokens.
 */
export function isBlankStop(message: AssistantMessageLike | undefined | null): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "stop") return false;
	if ((message.usage?.output ?? -1) !== 0) return false;
	if (typeof message.content === "string") return message.content.trim() === "";
	const content = message.content ?? [];
	if (content.some((part) => part.type === "toolCall")) return false;
	if (content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim() !== "")) return false;
	return true;
}

/**
 * True when a completed assistant message is the thinking-only failure
 * shape: a "successful" stop where the model streamed reasoning but never
 * produced an answer — non-empty thinking content, no text part, no tool
 * call, stopReason "stop" (observed from erica-flash: output: 47,
 * reasoning: 47, content: [one thinking block]).
 *
 * Unlike isBlankStop there is NO usage.output check here — thinking burns
 * output tokens, so this shape legitimately reports output > 0. The
 * structural check carries the discrimination instead, and it is safe:
 * pi's loop continues past a message only via tool calls, and a finished
 * answer requires a text part, so a stop message with thinking but neither
 * of those can never be a legitimate turn ending.
 *
 * Equally strict in what it rejects: thinking + text (a real answer with
 * visible reasoning) is not a failure; thinking + toolCall is a mid-run
 * turn, not an ending; empty/whitespace thinking with nothing else is left
 * alone (not the observed shape — don't guess beyond the evidence); and
 * non-"stop" stop reasons are handled by pi's own retry/truncation paths.
 */
export function isThinkingOnlyStop(message: AssistantMessageLike | undefined | null): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "stop") return false;
	if (typeof message.content === "string") return false;
	const content = message.content ?? [];
	if (content.some((part) => part.type === "toolCall")) return false;
	if (content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim() !== "")) return false;
	return content.some((part) => part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim() !== "");
}

/**
 * Register the blank-stop guard on a pi instance.
 *
 * State (the consecutive-blank counter) is closure-scoped per call, so each
 * registration — and thus each pi process — is isolated.
 *
 * @param options.enabled — when false, no hooks are registered and the
 *   guard is inert (same as if it had never existed). Defaults to true.
 *   Driven by `.pi-workflow/settings.json` → `blankStopGuard: false`.
 */
export function registerBlankStopGuard(pi: ExtensionAPI, options?: { enabled?: boolean }): void {
	if (options?.enabled === false) return;
	let consecutiveBlanks = 0;
	let lastTurnBlank = false;

	pi.on("turn_end", (event: TurnEndEvent) => {
		const message = event.message;
		if (isBlankStop(message) || isThinkingOnlyStop(message)) {
			consecutiveBlanks++;
			lastTurnBlank = true;
			return;
		}
		// Any turn with real content (text, tool calls) or a non-stop
		// outcome proves the model is healthy again — restore the full
		// nudge budget. Note output tokens alone no longer prove health:
		// a thinking-only stop burns output tokens too, which is why it
		// is checked structurally above rather than by usage.
		consecutiveBlanks = 0;
		lastTurnBlank = false;
	});

	pi.on("agent_end", (_event: AgentEndEvent) => {
		if (!lastTurnBlank) return;
		lastTurnBlank = false;
		if (consecutiveBlanks > MAX_CONSECUTIVE_BLANK_CONTINUES) return;
		// Must specify a delivery mode: during an agent_end handler pi still
		// considers itself streaming (agent-session.js clears the streaming
		// flag only after post-run handling), so a bare sendUserMessage
		// throws "Agent is already processing". "followUp" queues into
		// followUpQueue, which _handlePostAgentRun drains into
		// hasQueuedMessages() → agent.continue() — the built-in continuation
		// path for exactly this pattern. The message is visible in the
		// transcript, same as if the user typed it.
		try {
			pi.sendUserMessage(BLANK_STOP_CONTINUE_MESSAGE, { deliverAs: "followUp" });
		} catch (error) {
			// Never let a guard failure break the host session: degrade to
		// pre-guard behavior (blank result flows out) and leave a trace in
			// stderr for diagnosis.
			console.error(`blank-stop-guard: failed to send continue: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
