/**
 * Interactive graph nodes — `human()` and `mainAgent()`.
 *
 * Both pause the walk to bring judgement in from outside the agent pool.
 * Both are pi-native: `human()` uses ctx.ui, `mainAgent()` goes back to the
 * session that started the run. There is no external notification channel.
 *
 * The hard requirement for both is that a run without a UI must never hang.
 * A graph that blocks forever waiting for an answer nobody can give is worse
 * than one that proceeds on a stated default, because the first is invisible
 * and the second is at least recorded in the transcript.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphState } from "./graph-dsl.ts";
import type { HumanHandlerResult, InteractiveHandlers } from "./graph-node-runner.ts";

/** How an interactive node was answered. Edges can branch on this. */
export type InteractiveSource = "human" | "default" | "skipped" | "mainAgent";

/** Cap for state included in a checkpoint, so a long run stays readable. */
const STATE_PREVIEW_LIMIT = 2000;

function previewValue(value: unknown, limit: number): string {
	if (value === null || value === undefined) return "(none)";
	const text = typeof value === "string" ? value : String(value);
	const collapsed = text.trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Renders accumulated state for a human or the main agent.
 *
 * Results are rendered via String(), which yields an agent's text rather
 * than a JSON dump: the reader wants what the agent said, not its envelope.
 */
export function formatStateForReview(state: GraphState, limit = STATE_PREVIEW_LIMIT): string {
	const entries = Object.entries(state);
	if (entries.length === 0) return "(no state yet)";

	const perEntry = Math.max(200, Math.floor(limit / Math.max(1, entries.length)));
	return entries
		.map(([key, value]) => `${key}:\n${previewValue(value, perEntry)}`)
		.join("\n\n");
}

export interface InteractiveOptions {
	/**
	 * Present when the run has a UI. Absent in headless runs (`pi -p`,
	 * nested subagents), which is exactly when defaults matter.
	 */
	ctx?: ExtensionContext;
	/** Called for every interactive event, so it lands in the run log. */
	onEvent?: (message: string) => void;
}

/**
 * Builds the human-input handler.
 *
 * Choice nodes use a select dialog, free-text nodes use an input dialog.
 * A dismissed dialog is treated the same as no UI: fall back to the node's
 * default rather than blocking, because dismissing is a deliberate act and
 * re-prompting would trap the user in a loop they cannot exit.
 */
export function createHumanHandler(options: InteractiveOptions): InteractiveHandlers["onHuman"] {
	// Reports how the answer was obtained, not just what it was, so a
	// defaulted answer cannot be mistaken downstream for a chosen one.
	const fallback = (node: { default?: string }): HumanHandlerResult =>
		node.default !== undefined
			? { answer: node.default, source: "default" }
			: { answer: "", source: "none" };

	return async (node, _state) => {
		const hasUi = Boolean(options.ctx?.hasUI && options.ctx.ui);

		if (!hasUi) {
			const reason =
				node.default !== undefined
					? `No interactive session; used the default answer "${node.default}".`
					: "No interactive session and no default was set; the node was skipped.";
			options.onEvent?.(`human: ${reason}`);
			return fallback(node);
		}

		const ui = options.ctx!.ui;
		let answer: string | undefined;

		try {
			if (node.options && node.options.length > 0) {
				answer = await ui.select(node.prompt, node.options);
			} else {
				answer = await ui.input(node.prompt, "Type your answer");
			}
		} catch (error) {
			// A dialog failure must not abort a run that is otherwise fine.
			options.onEvent?.(
				`human: dialog failed (${error instanceof Error ? error.message : String(error)}); using the default.`,
			);
			return fallback(node);
		}

		if (answer === undefined || answer === "") {
			options.onEvent?.(
				node.default !== undefined
					? `human: dismissed; used the default answer "${node.default}".`
					: "human: dismissed with no default set.",
			);
			return fallback(node);
		}

		options.onEvent?.(`human: answered "${answer}".`);
		// A deliberate choice counts as a human answer even when it happens to
		// equal the default: the person was present and picked it.
		return { answer, source: "human" };
	};
}

/**
 * Builds the main-agent checkpoint handler.
 *
 * A checkpoint asks the session that started the run to weigh in mid-walk.
 * Since a tool cannot re-enter its own agent loop, the checkpoint is
 * surfaced to the human on the main agent's behalf: they answer as the
 * session would. This keeps the main agent a participant in the graph
 * without a central dispatcher, and without pretending to an autonomy the
 * runtime does not offer.
 *
 * Headless runs skip the checkpoint and say so, rather than fabricating an
 * answer that downstream edges would treat as considered judgement.
 */
export function createMainAgentHandler(
	options: InteractiveOptions,
): InteractiveHandlers["onMainAgent"] {
	return async (prompt, state) => {
		const hasUi = Boolean(options.ctx?.hasUI && options.ctx.ui);

		if (!hasUi) {
			options.onEvent?.("checkpoint: no interactive session, so it was skipped.");
			return "";
		}

		const ui = options.ctx!.ui;

		try {
			const answer = await ui.input(
				prompt,
				"Your decision (leave empty to skip)",
			);

			if (answer === undefined || answer.trim() === "") {
				options.onEvent?.("checkpoint: skipped without a decision.");
				return "";
			}

			options.onEvent?.(`checkpoint: "${previewValue(answer, 80)}"`);
			return answer;
		} catch (error) {
			options.onEvent?.(
				`checkpoint: dialog failed (${error instanceof Error ? error.message : String(error)}); skipped.`,
			);
			return "";
		}
	};
}

/** Builds both handlers for a run. */
export function createInteractiveHandlers(options: InteractiveOptions): InteractiveHandlers {
	return {
		onHuman: createHumanHandler(options),
		onMainAgent: createMainAgentHandler(options),
	};
}
