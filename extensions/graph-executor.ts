/**
 * Graph executor — walks a validated graph, runs nodes, routes on edges.
 *
 * The loop is deliberately small:
 *
 *   current = entry
 *   while current !== END:
 *     result       = run(current)
 *     state[current] = result
 *     current      = route(edge(current), state, result)
 *
 * Everything that makes coordination work is in those three lines. A node
 * produces a result; the result lands in shared state; an edge decides
 * where it goes next. When an implementer reports a blocker, the edge
 * routes back to whoever owns the contract, and that agent sees the blocker
 * in the state it receives. No message bus, no dispatcher, no coordination
 * tools inside the agents.
 */

import type { Edge, EndSymbol, GraphNode, GraphState, NodeDef } from "./graph-dsl.ts";
import { END } from "./graph-dsl.ts";
import type { BuiltGraph } from "./graph-dsl.ts";

export type NodeStatus = "ok" | "failed" | "skipped";

export interface NodeExecution {
	/** 1-based position in the walk. A node visited twice appears twice. */
	step: number;
	nodeId: string;
	nodeType: NodeDef["type"];
	/** Agent name for agent nodes; undefined otherwise. */
	agentName?: string;
	status: NodeStatus;
	result: unknown;
	/** Where the edge sent us. "END" when the run finished here. */
	routedTo: string;
	startedAt: number;
	durationMs: number;
	tokens?: number;
	error?: string;
}

export type GraphRunStatus = "completed" | "aborted" | "max_iterations";

export interface GraphRunResult {
	status: GraphRunStatus;
	/** Accumulated state: every visited node's result, keyed by node id. */
	state: GraphState;
	/** Every node execution in order, including repeat visits. */
	history: NodeExecution[];
	/** Node ids in visit order. Repeats included, so cycles are visible. */
	path: string[];
	iterations: number;
	startedAt: number;
	durationMs: number;
	/** Set when status is "aborted". */
	error?: string;
	/** Result of the last node executed, for convenience. */
	finalResult?: unknown;
}

/** Outcome of running one node. */
export interface NodeRunOutcome {
	result: unknown;
	tokens?: number;
	/**
	 * Marks a failure the graph cannot route around (spawn failure, bad
	 * config). Agent-level failures are NOT technical: an agent reporting it
	 * is blocked is a normal result that edges are expected to handle.
	 */
	technicalFailure?: boolean;
	error?: string;
}

export type NodeRunner = (
	node: GraphNode,
	state: GraphState,
	context: { step: number; runId: string; signal?: AbortSignal },
) => Promise<NodeRunOutcome>;

export interface GraphRunOptions {
	runId: string;
	/** Cap on node executions. Cycles are legal, so this bounds them. */
	maxIterations?: number;
	signal?: AbortSignal;
	/** Runs one node. Injected so the loop stays independent of spawning. */
	runNode: NodeRunner;
	/** Called after each node execution, for live display and journaling. */
	onNodeComplete?: (execution: NodeExecution) => void;
	/** Called before each node execution. */
	onNodeStart?: (info: { step: number; nodeId: string; nodeType: NodeDef["type"] }) => void;
}

export const DEFAULT_MAX_ITERATIONS = 25;

/** Reserved state keys the executor writes; node ids may not collide. */
const RESERVED_STATE_KEYS = new Set(["__error", "__lastNode", "__step"]);

export class GraphExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphExecutionError";
	}
}

function describeTarget(target: string | EndSymbol): string {
	return target === END ? "END" : String(target);
}

/**
 * Resolves an edge to the next node id, or END.
 *
 * A conditional edge is task-specific code written by the model, so it is
 * treated as untrusted: a throw, or a target that does not exist, becomes a
 * routing error rather than a crash. The graph is aborted with a message
 * naming the edge, since silently continuing would run the wrong agent.
 */
function resolveEdge(
	edge: Edge | undefined,
	nodeId: string,
	state: GraphState,
	result: unknown,
	graph: BuiltGraph,
): { target: string | EndSymbol } | { error: string } {
	if (!edge) {
		return { error: `Node "${nodeId}" has no outgoing edge.` };
	}

	if (edge.type === "direct") {
		return { target: edge.to };
	}

	let target: string | EndSymbol;
	try {
		target = edge.condition(state, result);
	} catch (error) {
		return {
			error: `Edge condition for node "${nodeId}" threw: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (target === END) return { target: END };

	if (typeof target !== "string" || target.length === 0) {
		return {
			error: `Edge condition for node "${nodeId}" returned ${JSON.stringify(target)}; expected a node name or END.`,
		};
	}

	if (!graph.nodes.has(target)) {
		const known = [...graph.nodes.keys()].join(", ");
		return {
			error: `Edge condition for node "${nodeId}" routed to unknown node "${target}". Defined nodes: ${known}.`,
		};
	}

	return { target };
}

/**
 * Runs a validated graph to completion.
 *
 * Node execution is injected via options.runNode, so this module has no
 * dependency on agent spawning and can be tested with scripted results.
 */
export async function runGraph(
	graph: BuiltGraph,
	options: GraphRunOptions,
): Promise<GraphRunResult> {
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new GraphExecutionError("maxIterations must be a positive integer");
	}

	for (const nodeId of graph.nodes.keys()) {
		if (RESERVED_STATE_KEYS.has(nodeId)) {
			throw new GraphExecutionError(`Node id "${nodeId}" is reserved by the executor`);
		}
	}

	const startedAt = Date.now();
	const state: GraphState = { ...graph.initialState };
	const history: NodeExecution[] = [];
	const path: string[] = [];

	let current: string | EndSymbol = graph.entry;
	let iterations = 0;
	let finalResult: unknown;

	const finish = (status: GraphRunStatus, error?: string): GraphRunResult => ({
		status,
		state,
		history,
		path,
		iterations,
		startedAt,
		durationMs: Date.now() - startedAt,
		error,
		finalResult,
	});

	while (current !== END) {
		if (options.signal?.aborted) {
			return finish("aborted", "Graph run was aborted");
		}

		if (iterations >= maxIterations) {
			// Cycles are a feature (escalation loops), so this is the only
			// backstop against one that never resolves. Report the path so the
			// loop is visible rather than just the count.
			const tail = path.slice(-6).join(" -> ");
			return finish(
				"max_iterations",
				`Graph exceeded ${maxIterations} node executions without reaching END. Recent path: ${tail}. If this is a legitimate long run, raise maxIterations; otherwise an edge condition is cycling.`,
			);
		}

		const nodeId = current as string;
		const node = graph.nodes.get(nodeId);
		if (!node) {
			return finish("aborted", `Node "${nodeId}" is not defined in the graph.`);
		}

		iterations += 1;
		const step = iterations;
		path.push(nodeId);

		options.onNodeStart?.({ step, nodeId, nodeType: node.def.type });

		const nodeStartedAt = Date.now();
		let outcome: NodeRunOutcome;
		try {
			outcome = await options.runNode(node, state, {
				step,
				runId: options.runId,
				signal: options.signal,
			});
		} catch (error) {
			// A throw from the runner is infrastructure failing, not an agent
			// reporting a problem. There is nothing sensible to route on.
			const message = error instanceof Error ? error.message : String(error);
			const execution: NodeExecution = {
				step,
				nodeId,
				nodeType: node.def.type,
				agentName: node.def.type === "agent" ? node.def.agentName : undefined,
				status: "failed",
				result: undefined,
				routedTo: "",
				startedAt: nodeStartedAt,
				durationMs: Date.now() - nodeStartedAt,
				error: message,
			};
			history.push(execution);
			options.onNodeComplete?.(execution);
			return finish("aborted", `Node "${nodeId}" failed: ${message}`);
		}

		// The result goes into state before routing, so an edge condition sees
		// the same state a downstream node will.
		state[nodeId] = outcome.result;
		finalResult = outcome.result;

		if (outcome.technicalFailure) {
			const execution: NodeExecution = {
				step,
				nodeId,
				nodeType: node.def.type,
				agentName: node.def.type === "agent" ? node.def.agentName : undefined,
				status: "failed",
				result: outcome.result,
				routedTo: "",
				startedAt: nodeStartedAt,
				durationMs: Date.now() - nodeStartedAt,
				tokens: outcome.tokens,
				error: outcome.error,
			};
			history.push(execution);
			options.onNodeComplete?.(execution);
			return finish(
				"aborted",
				`Node "${nodeId}" hit a technical failure: ${outcome.error ?? "unknown error"}`,
			);
		}

		const routed = resolveEdge(graph.edges.get(nodeId), nodeId, state, outcome.result, graph);

		if ("error" in routed) {
			const execution: NodeExecution = {
				step,
				nodeId,
				nodeType: node.def.type,
				agentName: node.def.type === "agent" ? node.def.agentName : undefined,
				status: "ok",
				result: outcome.result,
				routedTo: "",
				startedAt: nodeStartedAt,
				durationMs: Date.now() - nodeStartedAt,
				tokens: outcome.tokens,
				error: routed.error,
			};
			history.push(execution);
			options.onNodeComplete?.(execution);
			return finish("aborted", routed.error);
		}

		const execution: NodeExecution = {
			step,
			nodeId,
			nodeType: node.def.type,
			agentName: node.def.type === "agent" ? node.def.agentName : undefined,
			status: outcome.error ? "failed" : "ok",
			result: outcome.result,
			routedTo: describeTarget(routed.target),
			startedAt: nodeStartedAt,
			durationMs: Date.now() - nodeStartedAt,
			tokens: outcome.tokens,
			error: outcome.error,
		};
		history.push(execution);
		options.onNodeComplete?.(execution);

		current = routed.target;
	}

	return finish("completed");
}

/** Total tokens across every node execution in a run. */
export function totalTokens(result: GraphRunResult): number {
	return result.history.reduce((sum, execution) => sum + (execution.tokens ?? 0), 0);
}

/** Renders the walk as `a -> b -> c -> END`, showing repeats. */
export function formatPath(result: GraphRunResult): string {
	const steps = [...result.path];
	if (result.status === "completed") steps.push("END");
	return steps.join(" -> ");
}
