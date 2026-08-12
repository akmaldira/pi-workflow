/**
 * node_state reducer — the pure, closed-vocabulary function that turns a
 * dispatched action into an updated per-node accumulator.
 *
 * This is deliberately a fixed set of verbs implemented in the host process,
 * never agent-supplied code: the same principle that keeps the graph script
 * sandbox free of eval/Function/code-generation applies here — an agent can
 * choose *what* to write (key, value), never *how* the write is applied.
 *
 * Reads (`get` / `list`) return the reduced value directly, never the
 * action envelope that produced it — an agent reading its own accumulated
 * state back should never have to think about the action log, only the
 * current value.
 */

export type NodeStateActionVerb = "set" | "merge" | "append" | "get" | "list";

export interface NodeStateAction {
	action: NodeStateActionVerb;
	/** Required for set/merge/append/get; ignored for list. */
	key?: string;
	/** Required for set/merge/append; ignored for get/list. */
	value?: unknown;
	/** Optional provenance/context, stored alongside the value for set/merge/append. */
	meta?: Record<string, unknown>;
}

export type NodeStateData = Record<string, unknown>;

export interface NodeStateReduceResult {
	/** The updated accumulator. Identical reference to the input for read-only actions. */
	data: NodeStateData;
	/** Human-readable outcome, useful for the tool's reply text. */
	ok: boolean;
	error?: string;
}

/**
 * Applies one action to a node's accumulator and returns the new state.
 *
 * Pure: never mutates `data` in place (callers that want in-place semantics
 * should assign the returned `.data` back), so a caller can safely hold a
 * reference to the pre-reduce value (e.g. for journaling "before" state)
 * without it changing out from under them.
 */
export function reduceNodeStateAction(data: NodeStateData, action: NodeStateAction): NodeStateReduceResult {
	switch (action.action) {
		case "set": {
			if (!action.key) return { data, ok: false, error: "set requires a key." };
			return { data: { ...data, [action.key]: action.value }, ok: true };
		}
		case "merge": {
			if (!action.key) return { data, ok: false, error: "merge requires a key." };
			if (action.value === null || typeof action.value !== "object" || Array.isArray(action.value)) {
				return { data, ok: false, error: "merge requires an object value." };
			}
			const existing = data[action.key];
			const base = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
			return { data: { ...data, [action.key]: { ...base, ...action.value } }, ok: true };
		}
		case "append": {
			if (!action.key) return { data, ok: false, error: "append requires a key." };
			const existing = data[action.key];
			const base = Array.isArray(existing) ? existing : [];
			return { data: { ...data, [action.key]: [...base, action.value] }, ok: true };
		}
		case "get": {
			if (!action.key) return { data, ok: false, error: "get requires a key." };
			return { data, ok: true };
		}
		case "list": {
			return { data, ok: true };
		}
		default: {
			return { data, ok: false, error: `Unknown action "${(action as { action: string }).action}".` };
		}
	}
}

/**
 * Reads the current value for a key without applying an action — used by the
 * host to build the `get` reply's payload after reduceNodeStateAction confirms
 * the action was valid.
 */
export function readNodeStateValue(data: NodeStateData, key: string): unknown {
	return data[key];
}

/**
 * Per-node state accumulator for a single graph run.
 *
 * Keyed by node id, so parallel nodes in the same round never share a buffer —
 * the same guarantee `state[nodeId] = result` gives for final results today,
 * extended one layer inward to cover in-flight writes that happen before a
 * node finishes.
 *
 * A node's buffer is cleared when drained (at node completion) and reset when
 * the node re-runs (a revisit / cycle), matching the existing "revisiting a
 * node overwrites its state entry" rule: a node's accumulated state is
 * whatever its most recent complete visit produced, never merged across
 * visits.
 */
export class NodeStateBuffers {
	private readonly buffers = new Map<string, NodeStateData>();

	/**
	 * Applies an action to the named node's accumulator, returning the reduce
	 * result so the caller can build a reply (value or error) and decide
	 * whether to journal.
	 */
	apply(nodeId: string, action: NodeStateAction): NodeStateReduceResult {
		const current = this.buffers.get(nodeId) ?? {};
		const reduced = reduceNodeStateAction(current, action);
		if (reduced.ok) {
			this.buffers.set(nodeId, reduced.data);
		}
		return reduced;
	}

	/**
	 * Reads one key's current value for a node (for `get` replies). Returns
	 * undefined for a missing key or a node that has not accumulated anything.
	 */
	read(nodeId: string, key: string): unknown {
		return this.buffers.get(nodeId)?.[key];
	}

	/**
	 * Returns the whole accumulator for a node (for `list` replies).
	 */
	readAll(nodeId: string): NodeStateData {
		return this.buffers.get(nodeId) ?? {};
	}

	/**
	 * Removes and returns the accumulator for a node. Called by the node
	 * runner at completion so the values can be folded into `result.data`.
	 * Clears the entry so a re-run starts from a clean slate.
	 */
	drain(nodeId: string): NodeStateData {
		const data = this.buffers.get(nodeId) ?? {};
		this.buffers.delete(nodeId);
		return data;
	}

	/** Explicitly clears a node's buffer (used on revisit / cycle reset). */
	reset(nodeId: string): void {
		this.buffers.delete(nodeId);
	}

	/** Whether any node has accumulated state (used to short-circuit drain). */
	has(nodeId: string): boolean {
		return this.buffers.has(nodeId);
	}
}
