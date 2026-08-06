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

import type { AgentConfig } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import { classifySingleResultFailure } from "./failure-classifier.ts";
import type { GraphNode, GraphState } from "./graph-dsl.ts";
import type { NodeRunOutcome, NodeRunner } from "./graph-executor.ts";
import type { ForkContextOptions, SingleResult } from "./types.ts";
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
 * Extracts the escalation protocol from an agent's reply.
 *
 * Deliberately lenient about surrounding prose: agents wrap the block in
 * explanation, and rejecting that would push them back toward silently
 * giving up. Deliberately strict about the vocabulary: an unrecognised
 * BLOCKED_ON is preserved verbatim so an edge can still see it, rather than
 * being coerced into a category the agent did not choose.
 */
export function parseAgentResult(text: string, agentName: string): AgentNodeResult {
	const result: AgentNodeResult = { status: "ok", text, agent: agentName };

	// Non-enumerable so it never appears in JSON.stringify output or in the
	// journal, while still making string interpolation do the right thing.
	Object.defineProperty(result, "toString", {
		value: function toString(this: AgentNodeResult) {
			return this.text;
		},
		enumerable: false,
		writable: true,
	});

	const statusMatch = STATUS_LINE.exec(text);
	if (statusMatch && statusMatch[1].toLowerCase() === "blocked") {
		result.status = "blocked";
	}

	// Only populate escalation fields when the agent actually escalated, so a
	// passing mention of "REASON:" in ordinary prose cannot fake a blocker.
	if (result.status === "blocked") {
		for (const [field, pattern] of FIELD_PATTERNS) {
			const match = pattern.exec(text);
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
	agentScope?: "user" | "project" | "both";
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	preferredModelProvider?: string;
}

export type SpawnAgentFn = (
	cwd: string,
	agent: AgentConfig,
	prompt: string,
	options: Record<string, unknown>,
) => Promise<SingleResult>;

/**
 * Handlers for the two node types that pause the graph.
 *
 * Supplied by the tool layer, which owns the UI and the parent session.
 * Absent handlers degrade rather than hang: see task #16/#17.
 */
export interface InteractiveHandlers {
	onHuman?: (
		node: { prompt: string; options?: string[]; default?: string },
		state: GraphState,
	) => Promise<string>;
	onMainAgent?: (prompt: string, state: GraphState) => Promise<string>;
}

export interface CreateNodeRunnerOptions extends AgentSpawnOptions {
	spawnAgent: SpawnAgentFn;
	handlers?: InteractiveHandlers;
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

			case "mainAgent": {
				const prompt = node.def.promptFn(state);
				if (!options.handlers?.onMainAgent) {
					// Degrade rather than hang. The graph continues with an
					// explicit marker so an edge can notice the checkpoint was
					// skipped instead of mistaking silence for approval.
					return {
						result: {
							status: "skipped",
							reason: "No main-agent handler is available (headless run).",
							prompt,
						},
					};
				}
				const reply = await options.handlers.onMainAgent(prompt, state);
				return { result: { status: "ok", text: reply, prompt } };
			}

			case "human": {
				const def = node.def;
				if (!options.handlers?.onHuman) {
					return {
						result: {
							status: def.default !== undefined ? "default" : "skipped",
							answer: def.default,
							reason:
								def.default !== undefined
									? "No UI available; used the node's default answer."
									: "No UI available and no default was set.",
							prompt: def.prompt,
						},
					};
				}
				const answer = await options.handlers.onHuman(
					{ prompt: def.prompt, options: def.options, default: def.default },
					state,
				);
				return { result: { status: "ok", answer, prompt: def.prompt } };
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

		let single: SingleResult;
		try {
			single = await options.spawnAgent(options.cwd, resolved.agent, prompt, {
				runId: options.runId,
				index: spawnIndex,
				signal,
				parentSessionId: options.parentSessionId,
				forkContext: options.forkContext,
				onEvent: options.onEvent,
				artifactsDir: options.artifactsDir,
				context: resolved.agent.defaultContext ?? "fork",
				availableModels: options.availableModels,
				preferredModelProvider: options.preferredModelProvider,
				turnBudget: resolved.agent.turnBudget,
				toolBudget: resolved.agent.toolBudget,
				timeoutMs: resolved.agent.timeoutMs,
			});
		} catch (error) {
			return {
				result: null,
				technicalFailure: true,
				error: error instanceof Error ? error.message : String(error),
			};
		}

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
			};
		}

		const parsed = parseAgentResult(text, agentName);
		if (tokens) parsed.usage = { tokens };
		return { result: parsed, tokens };
	}
}
