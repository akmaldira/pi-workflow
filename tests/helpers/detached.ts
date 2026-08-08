/**
 * Test helper: await a detached graph run.
 *
 * `workflow` returns a start receipt and lets the walk continue in the
 * background, so a test that asserts on the *outcome* has to wait for the
 * report the run produces afterwards. `trackDetached()` supplies the
 * `onRunDetached` hook that captures it and a `settled()` that waits.
 *
 * Kept separate from the tool options a test already passes so existing call
 * shapes need only spread it in.
 */

import type { GraphRunReport } from "../../extensions/graph-run.ts";

export interface DetachedTracker {
	/** Spread into createGraphWorkflowTool's options. */
	onRunDetached: (info: { runId: string; done: Promise<GraphRunReport | undefined> }) => void;
	/**
	 * Resolves once the run started by the tracked call has finished.
	 *
	 * Returns undefined when the run crashed outright, which the tool reports
	 * through the manager rather than by rejecting.
	 */
	settled: () => Promise<GraphRunReport | undefined>;
}

export function trackDetached(): DetachedTracker {
	let done: Promise<GraphRunReport | undefined> | undefined;

	return {
		onRunDetached: (info) => {
			done = info.done;
		},
		settled: async () => (done ? await done : undefined),
	};
}
