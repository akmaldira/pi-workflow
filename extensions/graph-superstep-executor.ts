/**
 * Superstep executor — runs a graph with fan-out (parallel) nodes in
 * topological rounds (supersteps), with AND fan-in readiness and wave reset
 * on back-edges.
 *
 * This is the parallel counterpart to the linear `runGraph`. A graph runs
 * here when any node has more than one outgoing edge (`mode: "superstep"`).
 *
 * Model (see docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md, Decisions 5 & 6):
 *
 *   frontier = { entry }
 *   while frontier not empty:
 *     round += 1                          # maxIterations counts ROUNDS
 *     outcomes = await Promise.all(frontier.map(runNode))   # barrier isolation
 *     for each outcome: state[id] = result                # each under its own id
 *     frontier = computeNextFrontier(fired edges)         # in-degree + wave reset
 *
 * Readiness is AND fan-in: a node runs only when ALL its incoming edges'
 * sources have fired toward it. A fan-in node never sees partial data.
 *
 * Wave reset on a back-edge: when an edge fires at a node that already ran
 * (a cycle / escalation), the subgraph downstream of that target is reset —
 * every node there returns to its static in-degree and is forgotten as
 * executed — so the next wave restarts cleanly from the target. Siblings in
 * that subgraph re-run; pi-session resume makes those re-runs cheap.
 *
 * Two counters: `iterations` (rounds) feeds the safety cap; `nodeExecutions`
 * (nodes run) feeds display and budget. They were identical in the linear
 * executor but diverge here because a round can run N nodes.
 */

import type { BuiltGraph, Edge, EndSymbol, GraphState, NodeDef } from "./graph-dsl.ts";
import { END } from "./graph-dsl.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	describeTarget,
	GraphExecutionError,
	type GraphRunStatus,
	type NodeExecution,
	type NodeRunner,
	RESERVED_STATE_KEYS,
} from "./graph-executor.ts";

export interface SuperstepRunOptions {
	runId: string;
	/** Cap on ROUNDS (barriers), not node executions. */
	maxIterations?: number;
	signal?: AbortSignal;
	/** Runs one node. The same NodeRunner the linear executor uses. */
	runNode: NodeRunner;
	/** Called before each node execution. */
	onNodeStart?: (info: {
		step: number;
		nodeId: string;
		nodeType: NodeDef["type"];
		round?: number;
	}) => void;
	/** Called after each node execution, for live display and journaling. */
	onNodeComplete?: (execution: NodeExecution) => void;
	/** Called when a round's barrier completes, with the next frontier snapshot. */
	onRoundComplete?: (info: {
		round: number;
		nodeIds: string[];
		nextFrontier: string[];
		/** Remaining in-degree per node — the readiness ground truth for resume. */
		remainingInDegree: Record<string, number>;
	}) => void;
	/** Continue a previous run instead of starting from the entry node. */
	resume?: SuperstepResumeInput;
}

export interface SuperstepResumeInput {
	/** State rebuilt from the journal (initial + every recorded result). */
	state: GraphState;
	/** Nodes ready to run next, snapshotted at the last completed round. */
	resumeFromFrontier: string[];
	/** Remaining in-degree per node, snapshotted at the last completed round. */
	remainingInDegree: Record<string, number>;
	/** Rounds already completed, so the cap covers the whole run. */
	completedRounds: number;
	/** Node executions already completed (work-amount counter). */
	completedNodeExecutions: number;
	/**
	 * Nodes that already ran in completed rounds.
	 *
	 * Required, not derived from `history`: readiness is "in-degree 0 AND not
	 * yet executed", so an empty executed set would make every settled node
	 * look ready again and re-run the whole graph.
	 */
	executedNodeIds: string[];
	/** Prior executions, prepended to history so the run reads as one walk. */
	history?: NodeExecution[];
}

export interface SuperstepRunResult {
	status: GraphRunStatus;
	state: GraphState;
	history: NodeExecution[];
	/** Node ids in visit order, repeats included. */
	path: string[];
	/** Rounds run (feeds the maxIterations cap). */
	iterations: number;
	/** Total node executions (work amount, for display/budget). */
	nodeExecutions: number;
	startedAt: number;
	durationMs: number;
	error?: string;
	finalResult?: unknown;
}

/** An edge whose claim on `to` was released when `from` ran. */
interface FiredEdge {
	from: string;
	to: string;
	/** True when `from` actually routed here, rather than merely releasing a claim. */
	selected: boolean;
}

/** Outcome of resolving one node's outgoing edges. */
type EdgeResolution =
	| {
			/** Targets actually routed to. These become ready. */
			selected: string[];
			/**
			 * Every target whose claim this node's edges released, chosen or not.
			 *
			 * A conditional edge claimed each node it might select, so all of
			 * those claims must be released once it has decided — otherwise the
			 * ones it passed over would wait forever.
			 */
			resolved: string[];
	  }
	| { error: string };

/**
 * Static claims: how many edges could route to each node.
 *
 * A claim is released when the edge that made it resolves, whatever it chose.
 * Claims answer "is anything still able to route here?" — which, paired with
 * whether an edge actually selected the node, is what readiness needs. Edges to
 * END claim nothing.
 */
function computeStaticClaims(graph: BuiltGraph): Map<string, number> {
	const claims = new Map<string, number>();
	for (const id of graph.nodes.keys()) claims.set(id, 0);

	const add = (target: string): void => {
		if (!claims.has(target)) return;
		claims.set(target, (claims.get(target) ?? 0) + 1);
	};

	for (const [from, edgeList] of graph.edges) {
		for (const edge of edgeList) {
			if (edge.type === "direct") {
				if (edge.to !== END) add(edge.to as string);
				continue;
			}

			// A conditional edge claims every node it could select. Its actual
			// choice is not known until it runs, and a node must not be treated
			// as settled while an edge might still route to it.
			for (const target of conditionalTargetsOf(graph, from)) add(target);
		}
	}

	return claims;
}

/**
 * The nodes a conditional edge leaving `from` may select.
 *
 * Falls back to every node reachable from `from` when the targets could not be
 * read statically (a non-inline function, or a computed target). Over-claiming
 * only delays a node until the edge resolves, and is self-cancelling because an
 * edge decrements exactly the set it claimed; under-claiming would let a node
 * run without being routed to, which is the failure this exists to prevent.
 */
function conditionalTargetsOf(graph: BuiltGraph, from: string): string[] {
	const info = graph.conditionalTargets?.get(from);
	if (info?.analysable) return info.targets;

	// Unanalysable, or a graph built without script analysis.
	const reachable = fallbackReach.get(graph)?.get(from);
	return reachable ? [...reachable] : [];
}

/**
 * Conservative reach used when a conditional edge cannot be read statically.
 *
 * Every node except strict ancestors of `from`: claiming a node that must run
 * *before* `from` would deadlock, because a claim is only released when the
 * claiming node runs.
 */
const fallbackReach = new WeakMap<BuiltGraph, Map<string, Set<string>>>();

function primeFallbackReach(
	graph: BuiltGraph,
	forwardReachable: Map<string, Set<string>>,
): void {
	const map = new Map<string, Set<string>>();

	// Claim only what is reachable from the source, following direct edges and
	// any conditional targets that *were* readable. Claiming more than this
	// deadlocks: a claim is released only when the claiming node runs, so
	// claiming a node that has to run first blocks the very edge that would
	// release it.
	for (const from of graph.nodes.keys()) {
		const reach = new Set(forwardReachable.get(from) ?? []);
		reach.delete(from);
		map.set(from, reach);
	}

	fallbackReach.set(graph, map);
}

/**
 * Nodes reachable from `start` following DIRECT edges only, including `start`.
 *
 * Used to scope a wave reset: when `start` re-runs, everything downstream of
 * it (whose inputs transitively depend on it) should re-run too. Conditional
 * edges have unknown targets statically, so they are not followed; nodes
 * reachable only through a conditional are handled correctly anyway — they
 * reset themselves when re-targeted (detected as their own back-edge).
 */
function computeForwardReachable(graph: BuiltGraph): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();

	for (const start of graph.nodes.keys()) {
		const reachable = new Set<string>();
		const stack = [start];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (reachable.has(current)) continue;
			reachable.add(current);
			for (const edge of graph.edges.get(current) ?? []) {
				if (edge.type === "direct" && edge.to !== END) {
					stack.push(edge.to as string);
				}
			}
		}
		result.set(start, reachable);
	}

	return result;
}

/**
 * Evaluates a node's outgoing edges to find what it fired toward.
 *
 * A direct edge always fires at its target. A conditional edge fires at the
 * single target its condition returns (or nothing, if it returns END).
 * Targets are de-duplicated: two edges firing at the same node count once for
 * readiness. A throw or an unknown target is a routing error, not an agent
 * problem, and aborts the run.
 */
function resolveEdges(
	edges: Edge[],
	nodeId: string,
	state: GraphState,
	result: unknown,
	graph: BuiltGraph,
): EdgeResolution {
	const selected = new Set<string>();
	const resolved = new Set<string>();

	for (const edge of edges) {
		if (edge.type === "direct") {
			if (edge.to !== END) {
				selected.add(edge.to as string);
				resolved.add(edge.to as string);
			}
			continue;
		}

		// This edge claimed every node it might select, so every one of those
		// claims is released now that it has decided — including the ones it
		// passed over, which would otherwise never become ready.
		for (const candidate of conditionalTargetsOf(graph, edge.from)) resolved.add(candidate);

		let target: string | EndSymbol;
		try {
			target = edge.condition(state, result);
		} catch (error) {
			return {
				error: `Edge condition for node "${nodeId}" threw: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (target === END) continue;

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

		selected.add(target);
		resolved.add(target);
	}

	return { selected: [...selected], resolved: [...resolved] };
}

/**
 * Computes the next frontier after a round, applying edge firings, AND fan-in
 * readiness, and wave reset on back-edges.
 *
 * Mutates `remainingInDegree` and `executed` in place.
 */
function computeNextFrontier(
	firedEdges: FiredEdge[],
	executed: Set<string>,
	selected: Set<string>,
	remainingClaims: Map<string, number>,
	staticClaims: Map<string, number>,
	forwardReachable: Map<string, Set<string>>,
	entry: string,
): Set<string> {
	// 1. Partition: an edge routed at a node that already ran is a back-edge
	//    (cycle / escalation) and triggers a wave reset. Only a *selected*
	//    edge counts — merely releasing a claim is not a route.
	const resetTargets = new Set<string>();
	const normalFired: FiredEdge[] = [];

	for (const fired of firedEdges) {
		if (fired.selected && executed.has(fired.to)) {
			resetTargets.add(fired.to);
		} else {
			normalFired.push(fired);
		}
	}

	// 2. Union the reset subgraphs: every node downstream of a reset target.
	const resetNodes = new Set<string>();
	for (const target of resetTargets) {
		for (const node of forwardReachable.get(target) ?? []) {
			resetNodes.add(node);
		}
	}

	// 3. Apply the reset: restore claims, and forget both prior execution and
	//    prior selection so the next wave starts clean. Leaving `selected` set
	//    would let a node fire again without being routed to.
	for (const node of resetNodes) {
		remainingClaims.set(node, staticClaims.get(node) ?? 0);
		executed.delete(node);
		selected.delete(node);
	}
	for (const target of resetTargets) {
		// The escalation target re-runs now: it is routed to and ready.
		remainingClaims.set(target, 0);
		executed.delete(target);
		selected.add(target);
	}
	if (resetNodes.has(entry)) {
		// The entry node is always runnable.
		remainingClaims.set(entry, 0);
		selected.add(entry);
	}

	// 4. Release claims. Skip an edge whose SOURCE is in the reset subgraph:
	//    that source will re-run, so its edge has not really resolved. Skip
	//    reset targets, already forced ready above.
	for (const fired of normalFired) {
		if (resetNodes.has(fired.from)) continue;
		if (resetTargets.has(fired.to)) continue;
		const current = remainingClaims.get(fired.to) ?? 0;
		remainingClaims.set(fired.to, Math.max(0, current - 1));
		// Only an edge that actually routed here marks the node selected.
		if (fired.selected) selected.add(fired.to);
	}

	// 5. Ready = nothing can still route here, something did route here, and it
	//    has not already run this wave.
	//
	//    `selected` is what makes this a graph walk rather than a sweep over
	//    every node: without it, a node whose only incoming edges are
	//    conditional has no claims to wait on and would run immediately,
	//    whether or not any edge chose it.
	const next = new Set<string>();
	for (const [node, claims] of remainingClaims) {
		if (claims === 0 && selected.has(node) && !executed.has(node)) next.add(node);
	}
	return next;
}

function toRecord(map: Map<string, number>): Record<string, number> {
	const record: Record<string, number> = {};
	for (const [k, v] of map) record[k] = v;
	return record;
}

/**
 * Runs a superstep (parallel) graph to completion.
 *
 * Node execution is injected via options.runNode, mirroring the linear
 * executor, so this module has no dependency on agent spawning and is testable
 * with scripted results.
 */
export async function runSuperstepGraph(
	graph: BuiltGraph,
	options: SuperstepRunOptions,
): Promise<SuperstepRunResult> {
	if (graph.mode !== "superstep") {
		throw new GraphExecutionError(
			"runSuperstepGraph requires a graph with fan-out (mode 'superstep'). This graph is linear; use runGraph().",
		);
	}

	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new GraphExecutionError("maxIterations must be a positive integer");
	}

	for (const nodeId of graph.nodes.keys()) {
		if (RESERVED_STATE_KEYS.has(nodeId)) {
			throw new GraphExecutionError(`Node id "${nodeId}" is reserved by the executor`);
		}
	}

	// Reachability first: the conservative fallback for unreadable conditional
	// edges is scoped by it, and claims depend on that fallback.
	const forwardReachable = computeForwardReachable(graph);
	primeFallbackReach(graph, forwardReachable);
	const staticClaims = computeStaticClaims(graph);

	const resume = options.resume;
	const startedAt = Date.now();
	const state: GraphState = resume ? { ...resume.state } : { ...graph.initialState };
	const history: NodeExecution[] = resume?.history ? [...resume.history] : [];
	const path: string[] = history.map((execution) => execution.nodeId);

	const remainingClaims = new Map<string, number>();
	/** Nodes an edge actually routed to. Ready requires this, not just claims 0. */
	const selected = new Set<string>();
	const executed = new Set<string>();
	let frontier: Set<string>;
	let iterations: number;
	let nodeExecutions: number;
	let finalResult: unknown = resume ? history[history.length - 1]?.result : undefined;

	if (resume) {
		for (const [k, v] of Object.entries(resume.remainingInDegree)) {
			remainingClaims.set(k, v);
		}
		// The frontier was computed before the crash, so those nodes were
		// selected by definition.
		for (const nodeId of resume.resumeFromFrontier) selected.add(nodeId);
		frontier = new Set(resume.resumeFromFrontier);
		iterations = resume.completedRounds;
		nodeExecutions = resume.completedNodeExecutions;
		// Restore which nodes are already settled. Without this every node whose
		// in-degree reached 0 would be considered ready again.
		for (const nodeId of resume.executedNodeIds) executed.add(nodeId);
		// The frontier is explicitly the nodes to re-run, so they must not count
		// as settled (a crashed round's nodes are journaled but not complete).
		for (const nodeId of resume.resumeFromFrontier) executed.delete(nodeId);
	} else {
		for (const [k, v] of staticClaims) remainingClaims.set(k, v);
		// The entry is unconditionally ready: nothing routes to it to begin with.
		remainingClaims.set(graph.entry, 0);
		selected.add(graph.entry);
		frontier = new Set([graph.entry]);
		iterations = 0;
		nodeExecutions = 0;
	}

	let status: GraphRunStatus = "completed";
	let error: string | undefined;

	const finish = (): SuperstepRunResult => ({
		status,
		state,
		history,
		path,
		iterations,
		nodeExecutions,
		startedAt,
		durationMs: Date.now() - startedAt,
		error,
		finalResult,
	});

	while (frontier.size > 0) {
		if (options.signal?.aborted) {
			status = "aborted";
			error = "Graph run was aborted";
			break;
		}

		// The cap counts rounds (barriers), not node executions. A stuck cycle
		// climbs rounds regardless of how many nodes each round runs.
		if (iterations >= maxIterations) {
			status = "max_iterations";
			const tail = path.slice(-6).join(" -> ");
			error = `Graph exceeded ${maxIterations} rounds without reaching END. Recent path: ${tail}. If this is a legitimate long run, raise maxIterations; otherwise a cycle never resolves.`;
			break;
		}

		iterations += 1;
		const round = iterations;
		const roundNodeIds = [...frontier];
		const stepBase = nodeExecutions;

		// Fire every ready node concurrently. Writes are deferred until after
		// the barrier resolves, so no node sees another's result from this round.
		const roundResults = await Promise.all(
			roundNodeIds.map(async (nodeId, index) => {
				// Frontier nodes always come from the graph's validated node set.
				const node = graph.nodes.get(nodeId)!;
				const step = stepBase + index + 1;
				options.onNodeStart?.({ step, nodeId, nodeType: node.def.type, round });
				const nodeStartedAt = Date.now();
				try {
					const outcome = await options.runNode(node, state, {
						step,
						runId: options.runId,
						signal: options.signal,
					});
					return { nodeId, node, step, nodeStartedAt, outcome };
				} catch (error) {
					return {
						nodeId,
						node,
						step,
						nodeStartedAt,
						runnerError: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);

		let aborted = false;
		const firedEdges: FiredEdge[] = [];

		for (const r of roundResults) {
			const { nodeId, node } = r;

			nodeExecutions += 1;
			executed.add(nodeId);
			path.push(nodeId);
			const agentName = node.def.type === "agent" ? node.def.agentName : undefined;

			if ("runnerError" in r) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "failed",
					result: undefined,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					error: r.runnerError,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = `Node "${nodeId}" failed: ${r.runnerError}`;
				continue;
			}

			const outcome = r.outcome;
			// Write before routing so an edge condition sees the same state a
			// downstream node will. Each node writes under its own id (Decision 4).
			state[nodeId] = outcome.result;
			finalResult = outcome.result;

			if (outcome.technicalFailure) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "failed",
					result: outcome.result,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					tokens: outcome.tokens,
					error: outcome.error,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = `Node "${nodeId}" hit a technical failure: ${outcome.error ?? "unknown error"}`;
				continue;
			}

			const resolved = resolveEdges(
				graph.edges.get(nodeId) ?? [],
				nodeId,
				state,
				outcome.result,
				graph,
			);

			if ("error" in resolved) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "ok",
					result: outcome.result,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					tokens: outcome.tokens,
					error: resolved.error,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = resolved.error;
				continue;
			}

			for (const target of resolved.resolved) {
				firedEdges.push({
					from: nodeId,
					to: target,
					selected: resolved.selected.includes(target),
				});
			}

			const routedTo =
				resolved.selected.length > 0 ? resolved.selected.map(describeTarget).join(",") : "END";
			const execution: NodeExecution = {
				step: r.step,
				round,
				nodeId,
				nodeType: node.def.type,
				agentName,
				status: outcome.error ? "failed" : "ok",
				result: outcome.result,
				routedTo,
				startedAt: r.nodeStartedAt,
				durationMs: Date.now() - r.nodeStartedAt,
				tokens: outcome.tokens,
				error: outcome.error,
			};
			history.push(execution);
			options.onNodeComplete?.(execution);
		}

		if (aborted) break;

		frontier = computeNextFrontier(
			firedEdges,
			executed,
			selected,
			remainingClaims,
			staticClaims,
			forwardReachable,
			graph.entry,
		);

		options.onRoundComplete?.({
			round,
			nodeIds: roundNodeIds,
			nextFrontier: [...frontier],
			remainingInDegree: toRecord(remainingClaims),
		});
	}

	return finish();
}
