/**
 * Graph node runner — turns a graph node into real work.
 *
 * The executor owns routing and knows nothing about agents; this module
 * owns spawning and knows nothing about routing. They meet at the
 * NodeRunner signature.
 *
 * Agent results are parsed for the escalation protocol the bundled agents
 * are taught to emit (`STATUS: blocked` / `BLOCKED_ON: ...`). That parsing
 * is what turns a prompt-level convention into a routing key an edge can
 * branch on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import { classifySingleResultFailure } from "./failure-classifier.ts";
import type { GraphNode, GraphState } from "./graph-dsl.ts";
import type { NodeRunOutcome, NodeRunner } from "./graph-executor.ts";
import type { RequestBroker } from "./request-broker.ts";
import {
	type ArtifactConfig,
	type ForkContextOptions,
	type SingleResult,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "./types.ts";
import { getFinalOutput } from "./utils.ts";

/**
 * Structured view of an agent's reply, after escalation parsing.
 *
 * Carries a toString() so that interpolating a result into a prompt
 * (`${state.architect}`) yields the agent's text rather than
 * "[object Object]". Edge conditions need the structured fields, prompts
 * almost always want the text, and a script author should not have to
 * remember which is which — getting it wrong would silently feed garbage
 * to the next agent.
 */
export interface AgentNodeResult {
	/**
	 * "ok" when the agent completed normally, "blocked" when it reported an
	 * escalation. Edge conditions branch on this.
	 */
	status: "ok" | "blocked";
	/**
	 * Escalation target when blocked. A closed vocabulary so it can be a
	 * routing key: "contract" goes back to whoever designed the interface,
	 * "tests" to whoever wrote them, "environment" to a human.
	 */
	blockedOn?: string;
	reason?: string;
	evidence?: string;
	proposedFix?: string;
	/** Full text of the agent's reply, always present. */
	text: string;
	agent: string;
	/** Set when the agent finished but something went wrong along the way. */
	error?: string;
	usage?: { tokens: number };
}

const STATUS_LINE = /^\s*STATUS:\s*(\w[\w-]*)\s*$/im;

/** Escalation fields, narrowed to the string-valued keys so no cast is needed. */
type EscalationField = "blockedOn" | "reason" | "evidence" | "proposedFix";

const FIELD_PATTERNS: [EscalationField, RegExp][] = [
	["blockedOn", /^\s*BLOCKED_ON:\s*(.+)$/im],
	["reason", /^\s*REASON:\s*(.+)$/im],
	["evidence", /^\s*EVIDENCE:\s*(.+)$/im],
	["proposedFix", /^\s*PROPOSED_FIX:\s*(.+)$/im],
];

/** Escalation targets the bundled agents are taught to use. */
export const KNOWN_BLOCKED_ON = new Set([
	"contract",
	"tests",
	"environment",
	"requirements",
	"information",
	"conflict",
]);

/**
 * The escalation block injected into every workflow agent's system prompt.
 *
 * A custom agent authored without this block has no way to signal a blocker
 * the graph can route on, and gets forwarded as if it succeeded when it
 * hits a wall. Injecting here makes the protocol universal — bundled agents
 * already carry it (and are skipped by the dedup check), so this is the
 * safety net for user-authored agents that do not.
 *
 * The wording is kept identical to the `## Escalation` section documented in
 * SKILL.md and README.md, so a model that reads the docs and an agent that
 * receives the injection see the same instruction — no conflicting guidance.
 */
export const ESCALATION_PROTOCOL_BLOCK = `## Escalation

If you can't complete the task, say so instead of faking it:

STATUS: blocked
BLOCKED_ON: requirements | environment | conflict | contract | tests | information
REASON: <specifically what you hit>
EVIDENCE: <error output, file:line>
PROPOSED_FIX: <what would unblock you>

Reporting a blocker with a clear reason is a successful outcome. Faking completion is the only real failure.

## Tool Usage Restrictions vs Escalation
You have access to ask_user_question and ask_supervisor tools. However:
- DO NOT use ask_user_question or ask_supervisor to debug code errors, write implementations, or perform tasks. Those MUST be escalated by reporting STATUS: blocked.
- ask_user_question is strictly for choices requiring external human values/preferences (e.g. choosing between design trade-offs).
- ask_supervisor is strictly for high-level guidance or progress reports.
- Any technical failure, compilation error, or missing tool/file capability MUST be escalated via STATUS: blocked so the graph can route it.`;

/**
 * Returns an agent config with the escalation protocol in its system prompt.
 *
 * Idempotent: if the prompt already teaches the protocol (bundled agents,
 * or a custom agent whose author followed the docs), it is returned
 * unchanged. Otherwise the block is appended to a *clone* — the discovered
 * agent object is never mutated, so the injection cannot leak into other
 * call sites or persist across discovery passes.
 */
export function withEscalationProtocol(agent: AgentConfig): AgentConfig {
	if (agent.systemPrompt?.includes("STATUS: blocked")) return agent;
	const systemPrompt = agent.systemPrompt
		? `${agent.systemPrompt}\n\n${ESCALATION_PROTOCOL_BLOCK}`
		: ESCALATION_PROTOCOL_BLOCK;
	return { ...agent, systemPrompt };
}

/**
 * Extracts the escalation protocol from an agent's reply.
 *
 * Deliberately lenient about surrounding prose: agents wrap the block in
 * explanation, and rejecting that would push them back toward silently
 * giving up. Deliberately strict about the vocabulary: an unrecognised
 * BLOCKED_ON is preserved verbatim so an edge can still see it, rather than
 * being coerced into a category the agent did not choose.
 */
/**
 * Attaches the text-returning toString() to an agent result.
 *
 * Non-enumerable so it never lands in JSON.stringify output or the journal,
 * while still making `${state.architect}` interpolate to the agent's text.
 *
 * Exported because results also arrive from JSON.parse on resume, where the
 * prototype is lost. Without re-attaching, a resumed run silently renders
 * "[object Object]" into every prompt built from an earlier node.
 */
export function withResultText<T extends { text?: unknown }>(result: T): T {
	Object.defineProperty(result, "toString", {
		value: function toString(this: { text?: unknown }) {
			return typeof this.text === "string" ? this.text : "";
		},
		enumerable: false,
		writable: true,
		configurable: true,
	});
	return result;
}

/**
 * Re-attaches result behaviour to a state object rebuilt from JSON.
 *
 * Journal replay produces plain objects, so anything that looked like an
 * agent result needs its toString() back before prompts are built from it.
 */
export function rehydrateState(state: Record<string, unknown>): Record<string, unknown> {
	for (const value of Object.values(state)) {
		if (value && typeof value === "object" && !Array.isArray(value) && "text" in value) {
			withResultText(value as { text?: unknown });
		}
	}
	return state;
}

/**
 * Strips reasoning-trace markers some models prepend to every reply (e.g.
 * `<think></think>` before the actual content, or `<think>...</think>` with
 * a real trace inside). Escalation parsing is line-anchored (`^STATUS:`), so
 * a leading marker on the same line as STATUS silently defeats it — the
 * agent's escalation gets treated as an ordinary completion and the graph
 * routes to END instead of back to whoever owns the problem. Stripping here,
 * once, at the one place that decides routing, is cheaper than teaching
 * every regex about `<think>`.
 */
function stripThinkingMarkers(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
}

export function parseAgentResult(text: string, agentName: string): AgentNodeResult {
	const result: AgentNodeResult = withResultText({ status: "ok", text, agent: agentName });
	const searchText = stripThinkingMarkers(text);

	const statusMatch = STATUS_LINE.exec(searchText);
	if (statusMatch && statusMatch[1].toLowerCase() === "blocked") {
		result.status = "blocked";
	}

	// Only populate escalation fields when the agent actually escalated, so a
	// passing mention of "REASON:" in ordinary prose cannot fake a blocker.
	if (result.status === "blocked") {
		for (const [field, pattern] of FIELD_PATTERNS) {
			const match = pattern.exec(searchText);
			if (match) {
				const value = match[1].trim();
				if (value) result[field] = value;
			}
		}
		if (result.blockedOn) result.blockedOn = result.blockedOn.toLowerCase();
	}

	return result;
}

export interface ResolveAgentResult {
	agent?: AgentConfig;
	error?: string;
}

/**
 * Resolves an agent by name.
 *
 * Unlike the imperative workflow's resolver, an unknown name is an error
 * rather than a silent fallback to a generic agent. A graph that names a
 * nonexistent agent has a bug in it, and running something else instead
 * produces a plausible-looking result from the wrong role — the most
 * expensive kind of failure to notice.
 */
export function resolveGraphAgent(
	agentName: string,
	cwd: string,
	options: { agentScope?: "user" | "project" | "both" } = {},
): ResolveAgentResult {
	const { agents } = discoverAgents(cwd, options.agentScope ?? "both");
	const found = agents.find((a) => a.name === agentName);

	if (found) return { agent: found };

	const available = agents.map((a) => a.name).sort().join(", ") || "(none)";
	return {
		error: `Unknown agent "${agentName}". Available agents: ${available}.`,
	};
}

export interface AgentSpawnOptions {
	cwd: string;
	runId: string;
	signal?: AbortSignal;
	parentSessionId?: string;
	forkContext?: ForkContextOptions;
	onEvent?: (event: Record<string, unknown>) => void;
	artifactsDir?: string;
	/**
	 * Required for artifacts to actually be written: runSingleAgent gates on
	 * this, not on artifactsDir. Passing a directory without a config writes
	 * nothing, silently.
	 */
	artifactConfig?: ArtifactConfig;
	agentScope?: "user" | "project" | "both";
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	preferredModelProvider?: string;
	/** Extra environment variables injected into each spawned child. */
	extraEnv?: Record<string, string>;
}

export type SpawnAgentFn = (
	cwd: string,
	agent: AgentConfig,
	prompt: string,
	options: Record<string, unknown>,
) => Promise<SingleResult>;

/**
 * Handler for the node type that pauses the graph.
 *
 * Supplied by the tool layer, which owns the UI and the parent session.
 * Absent handlers degrade rather than hang: see task #16/#17.
 */
/**
 * What a human node produced, and how.
 *
 * `source` is not decoration: an edge that cannot tell "the human chose
 * hold" from "nobody was watching, so hold was assumed" would convert
 * absence into consent. A handler that resolved the default internally and
 * returned a bare string would erase that difference before the runner
 * could record it.
 */
export interface HumanHandlerResult {
	answer: string;
	source: "human" | "default" | "none";
}

export interface InteractiveHandlers {
	onHuman?: (
		node: { prompt: string; options?: string[]; default?: string },
		state: GraphState,
	) => Promise<string | HumanHandlerResult>;
}

export interface CreateNodeRunnerOptions extends AgentSpawnOptions {
	spawnAgent: SpawnAgentFn;
	handlers?: InteractiveHandlers;
	broker?: RequestBroker;
}

function usageTokens(result: SingleResult): number | undefined {
	const usage = result.usage as { totalTokens?: number } | undefined;
	return usage?.totalTokens;
}

/**
 * Builds the NodeRunner the executor calls for each node.
 */
export function createNodeRunner(options: CreateNodeRunnerOptions): NodeRunner {
	let spawnIndex = 0;

	return async function runNode(
		node: GraphNode,
		state: GraphState,
		context: { step: number; runId: string; signal?: AbortSignal },
	): Promise<NodeRunOutcome> {
		const signal = context.signal ?? options.signal;

		switch (node.def.type) {
			case "agent":
				return runAgentNode(node, node.def.agentName, node.def.promptFn(state), signal);

			case "human": {
				const def = node.def;
				const prompt = def.promptFn(state);

				// Route through RequestBroker if present (for background execution / IPC).
				if (options.broker) {
					const result = await options.broker.ask({
						runId: context.runId,
						nodeId: node.id,
						kind: "human",
						questions: [
							{
								question: prompt,
								header: node.id,
								options: def.options?.map((o) => ({ label: o })),
							},
						],
						default: def.default,
						expectsReply: true,
					});

					if (result.source === "cancelled") {
						return {
							result: withResultText({
								status: "skipped",
								text: "",
								reason: result.reason ?? "Cancelled by user.",
								prompt,
							}),
						};
					}

					const answer = result.text ?? def.default;
					const status = result.source === "default" ? "default" : "ok";

					return {
						result: withResultText({
							status,
							text: answer ?? "",
							answer,
							prompt,
							...(status === "ok"
								? {}
								: {
										reason: "No answer was given; fell back to the node's default.",
									}),
						}),
					};
				}

				if (!options.handlers?.onHuman) {
					const answer = def.default;
					return {
						result: withResultText({
							status: def.default !== undefined ? "default" : "skipped",
							// `text` mirrors `answer` so interpolating a human node's
							// result into a downstream prompt (`${state.ask}`) yields
							// the chosen value instead of "[object Object]" — the same
							// contract agent() results carry. `answer` stays for callers
							// that want the structured field by name.
							text: answer ?? "",
							answer,
							reason:
								def.default !== undefined
									? "No UI available; used the node's default answer."
									: "No UI available and no default was set.",
							prompt,
						}),
					};
				}
				const raw = await options.handlers.onHuman(
					{ prompt, options: def.options, default: def.default },
					state,
				);

				// A bare string is accepted for convenience, but cannot say how it
				// was obtained, so it is inferred conservatively: only a non-empty
				// value that differs from the default counts as a real answer.
				const reported: HumanHandlerResult =
					typeof raw === "string"
						? {
								answer: raw,
								source: raw === "" ? "none" : raw === def.default ? "default" : "human",
							}
						: raw;

				const status =
					reported.source === "human" ? "ok" : reported.source === "default" ? "default" : "skipped";
				const answer = reported.answer || def.default;

				return {
					result: withResultText({
						status,
						text: answer ?? "",
						answer,
						prompt,
						...(status === "ok"
							? {}
							: {
									reason:
										status === "default"
											? "No answer was given; fell back to the node's default."
											: "No answer was given and no default was set.",
								}),
					}),
				};
			}
		}
	};

	async function runAgentNode(
		node: GraphNode,
		agentName: string,
		prompt: string,
		signal: AbortSignal | undefined,
	): Promise<NodeRunOutcome> {
		const resolved = resolveGraphAgent(agentName, options.cwd, {
			agentScope: options.agentScope,
		});

		if (!resolved.agent) {
			// Configuration error, not something an agent can be asked to fix.
			return { result: null, technicalFailure: true, error: resolved.error };
		}

		spawnIndex += 1;

		// `withEscalationProtocol` is applied unconditionally (deduped for bundled
		// agents), so the spawn path above is the only place sessionFile lives.
		const agentWithProtocol = withEscalationProtocol(resolved.agent);
		const sessionFile = path.join(
			options.cwd,
			".pi-workflow",
			"sessions",
			options.runId,
			`${node.id}.jsonl`,
		);
		let single: SingleResult;
		try {
			// First spawn of this node in this run? The fork summary
			// (a compaction of the orchestrator's parent session) bootstraps the
			// agent's context exactly as today. A REVISIT, by contrast, resumes an
			// existing session, so the agent walks in with its own full history
			// already in the transcript — re-injecting a parent summary would be
			// noise (and risk a prompt-length runaway).
			const sessionExists = fs.existsSync(sessionFile);
			const forkContext = sessionExists ? undefined : options.forkContext;

			single = await options.spawnAgent(options.cwd, agentWithProtocol, prompt, {
				runId: options.runId,
				index: spawnIndex,
				signal,
				parentSessionId: options.parentSessionId,
				forkContext,
				sessionFile,
				onEvent: options.onEvent,
				artifactsDir: options.artifactsDir,
				artifactConfig: options.artifactConfig,
				context: resolved.agent.defaultContext ?? "fork",
				availableModels: options.availableModels,
				preferredModelProvider: options.preferredModelProvider,
				turnBudget: resolved.agent.turnBudget,
				toolBudget: resolved.agent.toolBudget,
				timeoutMs: resolved.agent.timeoutMs,
				extraEnv: options.extraEnv,
				maxSubagentDepth: resolveChildMaxSubagentDepth(
					resolveCurrentMaxSubagentDepth(),
					resolved.agent.maxSubagentDepth,
				),
			});
		} catch (error) {
			return {
				result: null,
				technicalFailure: true,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const sessionId = sessionFile;
		const text = getFinalOutput(single.messages ?? []) || single.error || "";
		const tokens = usageTokens(single);

		// Only classify when something actually went wrong; a clean run is
		// never a failure.
		if (single.exitCode !== 0 || single.error || single.errorMessage) {
			const classification = classifySingleResultFailure(single);

			if (classification.class === "technical") {
				// Infrastructure failed. There is no agent judgement to route on.
				return {
					result: { status: "failed", agent: agentName, text, error: classification.reason },
					technicalFailure: true,
					error: classification.reason,
					tokens,
				};
			}

			// An agent-level failure is a routable outcome, not an abort. The
			// agent tried and could not finish; an edge decides what happens.
			const parsed = parseAgentResult(text, agentName);
			return {
				result: { ...parsed, error: classification.reason, usage: tokens ? { tokens } : undefined },
				error: classification.reason,
				tokens,
				sessionId,
			};
		}

		const parsed = parseAgentResult(text, agentName);
		if (tokens) parsed.usage = { tokens };
		return { result: parsed, tokens, sessionId };
	}
}
