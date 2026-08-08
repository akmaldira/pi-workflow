/**
 * Tool definitions for user and supervisor communication.
 *
 * Implements:
 *  - ask_user_question: batched multi-question custom TUI, registered for both
 *    parent and child agents.
 *  - ask_human: simple single-prompt wrapper that returns text directly.
 *  - ask_supervisor: lets child agents ask the main agent for decisions.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	runAskUserQuestionTUI,
	validateQuestions,
	type TUIQuestion,
	type TUIAnswer,
} from "./ask-user-question-tui.ts";
import { ChannelClient } from "./channel.ts";

// ── Schemas ──────────────────────────────────────────────────────────────

const TUIOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option, max 60 chars" }),
	description: Type.Optional(Type.String({ description: "Optional description of trade-offs" })),
	preview: Type.Optional(Type.String({ description: "Markdown preview text shown beside/below options" })),
});

const TUIQuestionSchema = Type.Object({
	question: Type.String({ description: "The full question text to display, ending with ?" }),
	header: Type.String({ description: "Short tab label, max 16 chars" }),
	options: Type.Optional(Type.Array(TUIOptionSchema, { description: "Options to choose from" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(TUIQuestionSchema, { description: "1 to 4 questions to ask" }),
});

const AskHumanParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(
		Type.Array(Type.String(), { description: "Optional options to choose from" }),
	),
	default: Type.Optional(Type.String({ description: "Default fallback answer" })),
});

const AskSupervisorParams = Type.Object({
	question: Type.String({ description: "The question to ask the supervisor (main agent)" }),
	expectsReply: Type.Optional(
		Type.Boolean({ description: "Whether you expect a reply or if it is a progress report (default: true)" }),
	),
	default: Type.Optional(Type.String({ description: "Default answer to proceed with on timeout" })),
});

// ── Tool Definitions ────────────────────────────────────────────────────

/**
 * The `ask_user_question` tool.
 *
 * Full-parity custom TUI questionnaire. Available to both main agent (runs
 * in-process) and child agents (routes through the filesystem channel).
 */
export function createAskUserQuestionTool(): ToolDefinition {
	return defineTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more questions. Can specify options (with descriptions and markdown previews), " +
			"multi-select mode, per-option notes, and a free-text 'Other' choice. Renders a unified tabbed dialog.",
		parameters: AskUserQuestionParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as TUIQuestion[];

			// 1. Child process check
			const client = ChannelClient.fromEnv();
			if (client) {
				const reply = await client.ask({
					kind: "human",
					question: questions[0]?.question ?? "Questionnaire",
					expectsReply: true,
					questions: questions.map((q) => ({
						question: q.question,
						header: q.header,
						options: q.options?.map((o) => ({ label: o.label, description: o.description })),
						multiSelect: q.multiSelect,
					})),
				});

				return {
					content: [
						{
							type: "text" as const,
							text: reply.answer
								? `User answered: ${reply.answer}`
								: "User cancelled the question.",
						},
					],
					details: {
						answers: reply.answers ?? [],
						cancelled: reply.source === "cancelled",
						error: reply.source === "timeout" ? "timeout" : undefined,
					},
				};
			}

			// 2. Parent process: validation first
			const validationError = validateQuestions(questions);
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Validation failed: ${validationError}` }],
					details: { answers: [], cancelled: false, error: validationError },
				};
			}

			// 3. Parent process: TUI execution
			if (ctx.mode === "tui" && ctx.ui) {
				const result = await runAskUserQuestionTUI(ctx, questions);
				return {
					content: [
						{
							type: "text" as const,
							text: result.cancelled
								? "User cancelled the question."
								: "Questions answered successfully.",
						},
					],
					details: result,
				};
			}

			// 4. Parent process: non-TUI fallback (sequential select/input if UI exists)
			if (ctx.hasUI && ctx.ui) {
				const answers: TUIAnswer[] = [];
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					let ans: string | undefined;

					if (q.options && q.options.length > 0) {
						ans = await ctx.ui.select(
							`${q.question} (${i + 1}/${questions.length})`,
							q.options.map((o) => o.label),
						);
					} else {
						ans = await ctx.ui.input(`${q.question} (${i + 1}/${questions.length})`);
					}

					if (ans === undefined) {
						return {
							content: [{ type: "text" as const, text: "User cancelled the question." }],
							details: { answers: [], cancelled: true },
						};
					}

					answers.push({
						questionIndex: i,
						kind: q.options ? "option" : "custom",
						answer: ans || null,
					});
				}

				return {
					content: [{ type: "text" as const, text: "Questions answered successfully." }],
					details: { answers, cancelled: false },
				};
			}

			// 5. Parent process: headless fallback (use defaults)
			const answers: TUIAnswer[] = questions.map((q, i) => ({
				questionIndex: i,
				kind: "option",
				answer: null,
			}));

			return {
				content: [{ type: "text" as const, text: "Headless mode; used default fallbacks." }],
				details: { answers, cancelled: false },
			};
		},
	});
}

/**
 * The `ask_human` tool.
 *
 * Simple single-question wrapper that matches the standard subagent pattern
 * and maps internally to `ask_user_question`.
 */
export function createAskHumanTool(): ToolDefinition {
	return defineTool({
		name: "ask_human",
		label: "Ask Human",
		description:
			"Ask the user a question and get a text answer back. Can optional restrict to a list of options. " +
			"Use this when you need human guidance, approval, or specific values.",
		parameters: AskHumanParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { question, options, default: defVal } = params;

			// Map to ask_user_question questions format
			const mappedQuestions: TUIQuestion[] = [
				{
					question: question as string,
					header: "Question",
					options: (options as string[] | undefined)?.map((o) => ({ label: o })),
				},
			];

			// 1. Child process check
			const client = ChannelClient.fromEnv();
			if (client) {
				const reply = await client.ask({
					kind: "human",
					question: question as string,
					options: (options as string[] | undefined)?.map((o) => ({ label: o })),
					expectsReply: true,
					default: defVal as string | undefined,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: reply.answer
								? `User answered: ${reply.answer}`
								: "User cancelled the question.",
						},
					],
					details: {
						answer: reply.answer ?? null,
						cancelled: reply.source === "cancelled",
						error: reply.source === "timeout" ? "timeout" : undefined,
					},
				};
			}

			// 2. Parent process: TUI execution
			if (ctx.mode === "tui" && ctx.ui) {
				const result = await runAskUserQuestionTUI(ctx, mappedQuestions);
				const answer = result.answers[0]?.answer ?? null;
				return {
					content: [
						{
							type: "text" as const,
							text: result.cancelled
								? "User cancelled the question."
								: `User answered: ${answer}`,
						},
					],
					details: {
						answer,
						cancelled: result.cancelled,
					},
				};
			}

			// 3. Parent process: non-TUI fallback
			if (ctx.hasUI && ctx.ui) {
				let ans: string | undefined;
				if (options && (options as string[]).length > 0) {
					ans = await ctx.ui.select(question as string, options as string[]);
				} else {
					ans = await ctx.ui.input(question as string);
				}

				if (ans === undefined) {
					return {
						content: [{ type: "text" as const, text: "User cancelled the question." }],
						details: { answer: defVal ?? null, cancelled: true },
					};
				}

				return {
					content: [{ type: "text" as const, text: `User answered: ${ans}` }],
					details: { answer: ans, cancelled: false },
				};
			}

			// 4. Parent process: headless fallback
			return {
				content: [{ type: "text" as const, text: "Headless mode; used default fallback." }],
				details: { answer: defVal ?? null, cancelled: false },
			};
		},
	});
}

/**
 * The `ask_supervisor` tool.
 *
 * Lets a child subagent ask the main agent (the supervisor) for a decision
 * or report progress. The question is injected into the main agent's session
 * and answered via the workflow_reply tool.
 */
export function createAskSupervisorTool(): ToolDefinition {
	return defineTool({
		name: "ask_supervisor",
		label: "Ask Supervisor",
		description:
			"Ask the supervisor (the orchestrator/main agent) for a decision or instruction. " +
			"Use this when you are blocked, need a choice resolved, or need to report progress.",
		parameters: AskSupervisorParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { question, expectsReply, default: defVal } = params;
			const shouldReply = expectsReply !== false;

			// 1. Child process check
			const client = ChannelClient.fromEnv();
			if (client) {
				const reply = await client.ask({
					kind: "supervisor",
					question: question as string,
					expectsReply: shouldReply,
					default: defVal as string | undefined,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: reply.answer
								? `Supervisor answered: ${reply.answer}`
								: `Supervisor request completed (${reply.source}).`,
						},
					],
					details: {
						answer: reply.answer ?? null,
						source: reply.source,
						reason: reply.reason,
					},
				};
			}

			// 2. Parent process: mock fallback (supervisor cannot ask itself)
			return {
				content: [
					{
						type: "text" as const,
						text: `Called from supervisor session directly. Answered with default fallback: "${
							defVal ?? "proceed"
						}"`,
					},
				],
				details: {
					answer: defVal ?? "proceed",
					source: "default",
					reason: "Called in parent session; no child channel active.",
				},
			};
		},
	});
}
