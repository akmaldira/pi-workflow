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
