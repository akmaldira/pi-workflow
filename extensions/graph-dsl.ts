/**
 * Graph DSL — the builder API exposed inside a graph workflow script.
 *
 * A graph script declares nodes (who does work) and edges (where the result
 * goes next). Coordination lives in the edges: when an implementer reports
 * a blocker, an edge routes back to whoever can resolve it, and that agent
 * sees the blocker in the state it receives. There is no message bus, no
 * dispatcher, and no coordination tools inside the agents — routing plus
 * accumulated state is the whole mechanism.
 *
 * This module is pure: it builds and validates a graph description. It does
 * not spawn agents, touch the filesystem, or execute anything. The executor
 * consumes what `buildGraphFromScript` returns.
 */

/** Terminal target for an edge. Reaching it ends the run. */
export const END: unique symbol = Symbol("END");
export type EndSymbol = typeof END;

export type NodeType = "agent" | "mainAgent" | "human";

/** State accumulated so far, keyed by node id. */
export type GraphState = Record<string, unknown>;

/** Builds a node's prompt from the state available when it runs. */
export type PromptFn = (state: GraphState) => string;

/**
 * Chooses the next node from the current node's result.
 *
 * Pure by construction: the sandbox exposes nothing with side effects, so a
 * condition can only inspect state and return a target.
 */
export type EdgeConditionFn = (state: GraphState, result: unknown) => string | EndSymbol;

export interface HumanNodeOptions {
	/** Presented as a fixed set of choices rather than free text. */
	options?: string[];
	/**
	 * Answer to use when running without a UI. Without this a headless run
	 * would have to either hang or invent an answer; both are worse than an
	 * explicit default the author chose.
	 */
	default?: string;
}

export interface AgentNodeDef {
	type: "agent";
	agentName: string;
	promptFn: PromptFn;
}

export interface MainAgentNodeDef {
	type: "mainAgent";
	promptFn: PromptFn;
}

export interface HumanNodeDef {
	type: "human";
	prompt: string;
	options?: string[];
	default?: string;
}

export type NodeDef = AgentNodeDef | MainAgentNodeDef | HumanNodeDef;

export interface GraphNode {
	id: string;
	def: NodeDef;
}

export type Edge =
	| { type: "direct"; from: string; to: string | EndSymbol }
	| { type: "conditional"; from: string; condition: EdgeConditionFn };

export interface BuiltGraph {
	nodes: Map<string, GraphNode>;
	edges: Map<string, Edge>;
	entry: string;
	initialState: GraphState;
}

export class GraphDefinitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphDefinitionError";
	}
}

const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Node ids double as state keys (`state.planner`), so they must be valid
 * identifiers. Rejecting bad ids here produces a clear definition error
 * instead of a confusing failure later in a prompt function.
 */
function assertValidNodeId(id: unknown): asserts id is string {
	if (typeof id !== "string" || id.length === 0) {
		throw new GraphDefinitionError("Node id must be a non-empty string");
	}
	if (!NODE_ID_PATTERN.test(id)) {
		throw new GraphDefinitionError(
			`Invalid node id "${id}": must start with a letter or underscore and contain only letters, digits, and underscores`,
		);
	}
}

function describeTarget(target: string | EndSymbol): string {
	return target === END ? "END" : `"${String(target)}"`;
}

// --- Node constructors, exposed as sandbox globals ---

export function agent(agentName: string, promptFn: PromptFn): AgentNodeDef {
	if (typeof agentName !== "string" || agentName.trim().length === 0) {
		throw new GraphDefinitionError("agent() requires an agent name");
	}
	if (typeof promptFn !== "function") {
		throw new GraphDefinitionError(
			`agent("${agentName}") requires a prompt function: agent("${agentName}", (state) => "...")`,
		);
	}
	return { type: "agent", agentName: agentName.trim(), promptFn };
}

export function mainAgent(prompt: string | PromptFn): MainAgentNodeDef {
	if (typeof prompt === "string") {
		const text = prompt;
		return { type: "mainAgent", promptFn: () => text };
	}
	if (typeof prompt !== "function") {
		throw new GraphDefinitionError("mainAgent() requires a prompt string or function");
	}
	return { type: "mainAgent", promptFn: prompt };
}

export function human(prompt: string, options: HumanNodeOptions = {}): HumanNodeDef {
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		throw new GraphDefinitionError("human() requires a prompt string");
	}
	if (options.options !== undefined) {
		if (!Array.isArray(options.options) || options.options.length === 0) {
			throw new GraphDefinitionError("human() options must be a non-empty array of strings");
		}
		if (!options.options.every((o) => typeof o === "string")) {
			throw new GraphDefinitionError("human() options must all be strings");
		}
	}
	if (options.default !== undefined && typeof options.default !== "string") {
		throw new GraphDefinitionError("human() default must be a string");
	}
	if (options.default !== undefined && options.options && !options.options.includes(options.default)) {
		throw new GraphDefinitionError(
			`human() default "${options.default}" is not one of the provided options`,
		);
	}
	return {
		type: "human",
		prompt,
		options: options.options ? [...options.options] : undefined,
		default: options.default,
	};
}

// --- Graph builder ---

export class GraphBuilder {
	private readonly nodes = new Map<string, GraphNode>();
	private readonly edges = new Map<string, Edge>();
	private entry: string | null = null;
	private initialState: GraphState = {};
	private started = false;

	node(id: string, def: NodeDef): this {
		assertValidNodeId(id);
		if (this.nodes.has(id)) {
			throw new GraphDefinitionError(`Node "${id}" is already defined`);
		}
		if (!def || typeof def !== "object" || !("type" in def)) {
			throw new GraphDefinitionError(
				`Node "${id}" must be defined with agent(), mainAgent(), or human()`,
			);
		}
		this.nodes.set(id, { id, def });

		// First node declared is the entry unless start() says otherwise.
		// Saves a redundant start() call in the common linear case.
		if (this.entry === null) this.entry = id;
		return this;
	}

	edge(from: string, target: string | EndSymbol | EdgeConditionFn): this {
		assertValidNodeId(from);

		if (this.edges.has(from)) {
			throw new GraphDefinitionError(
				`Node "${from}" already has an outgoing edge. A node has at most one edge; use a conditional edge to branch.`,
			);
		}

		if (typeof target === "function") {
			this.edges.set(from, { type: "conditional", from, condition: target });
			return this;
		}

		if (target === END) {
			this.edges.set(from, { type: "direct", from, to: END });
			return this;
		}

		assertValidNodeId(target);
		this.edges.set(from, { type: "direct", from, to: target });
		return this;
	}

	start(id: string): this {
		assertValidNodeId(id);
		this.entry = id;
		return this;
	}

	/**
	 * Records the initial state and marks the graph ready to run.
	 *
	 * Does not execute: the sandbox only builds a description, and the
	 * executor runs it afterwards with real agent-spawning capability.
	 */
	run(initialState: GraphState = {}): this {
		if (this.started) {
			throw new GraphDefinitionError("run() may only be called once");
		}
		if (initialState !== undefined && initialState !== null) {
			if (typeof initialState !== "object" || Array.isArray(initialState)) {
				throw new GraphDefinitionError("run() initial state must be an object");
			}
		}
		this.started = true;
		this.initialState = { ...(initialState ?? {}) };
		return this;
	}

	wasStarted(): boolean {
		return this.started;
	}

	/** Structural validation. Returns every problem found, not just the first. */
	validate(): string[] {
		const errors: string[] = [];

		if (this.nodes.size === 0) {
			errors.push("Graph has no nodes. Define at least one with g.node(id, agent(...)).");
			return errors;
		}

		if (!this.started) {
			errors.push("Graph was never run. Call g.run({ ... }) at the end of the script.");
		}

		if (this.entry === null) {
			errors.push("Graph has no entry node. Call g.start(nodeId).");
		} else if (!this.nodes.has(this.entry)) {
			errors.push(`Entry node "${this.entry}" is not defined.`);
		}

		for (const [from, edge] of this.edges) {
			if (!this.nodes.has(from)) {
				errors.push(`Edge is defined from unknown node "${from}".`);
			}
			if (edge.type === "direct" && edge.to !== END && !this.nodes.has(edge.to)) {
				errors.push(`Edge "${from}" -> ${describeTarget(edge.to)} points at an undefined node.`);
			}
		}

		for (const id of this.nodes.keys()) {
			if (!this.edges.has(id)) {
				errors.push(
					`Node "${id}" has no outgoing edge. Every node needs one; use g.edge("${id}", END) to finish there.`,
				);
			}
		}

		// Reachability is checked only when every edge is direct. A single
		// conditional edge makes the reachable set undecidable without running
		// the condition, and guessing would reject valid graphs. The executor's
		// iteration cap is the backstop for a graph that never terminates.
		if (errors.length === 0 && this.entry !== null) {
			const conditionals = [...this.edges.values()].filter((e) => e.type === "conditional");
			if (conditionals.length === 0) {
				if (!this.canReachEnd(this.entry)) {
					errors.push(
						"No path from the entry node reaches END. The graph would loop forever; add an edge to END.",
					);
				}
				for (const id of this.nodes.keys()) {
					if (!this.isReachable(this.entry, id)) {
						errors.push(`Node "${id}" is unreachable from the entry node "${this.entry}".`);
					}
				}
			}
		}

		return errors;
	}

	private canReachEnd(from: string): boolean {
		const seen = new Set<string>();
		const stack = [from];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);

			const edge = this.edges.get(current);
			if (!edge) continue;
			if (edge.type === "conditional") return true;
			if (edge.to === END) return true;
			stack.push(edge.to as string);
		}

		return false;
	}

	private isReachable(from: string, target: string): boolean {
		if (from === target) return true;

		const seen = new Set<string>();
		const stack = [from];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);

			const edge = this.edges.get(current);
			if (!edge || edge.type === "conditional") continue;
			if (edge.to === END) continue;
			if (edge.to === target) return true;
			stack.push(edge.to as string);
		}

		return false;
	}

	build(): BuiltGraph {
		const errors = this.validate();
		if (errors.length > 0) {
			throw new GraphDefinitionError(`Invalid graph:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
		}

		return {
			nodes: new Map(this.nodes),
			edges: new Map(this.edges),
			entry: this.entry!,
			initialState: { ...this.initialState },
		};
	}
}

/**
 * Creates the graph builder. One graph per script: a second call is a
 * definition error, so the executor never has to guess which graph to run.
 */
export function createGraphFactory(): { graph: () => GraphBuilder; getBuilder: () => GraphBuilder | null } {
	let builder: GraphBuilder | null = null;

	return {
		graph: () => {
			if (builder !== null) {
				throw new GraphDefinitionError("Only one graph() per script is allowed");
			}
			builder = new GraphBuilder();
			return builder;
		},
		getBuilder: () => builder,
	};
}
