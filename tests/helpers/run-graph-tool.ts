/**
 * Test helper: start the `workflow` tool and wait for the detached run.
 *
 * Runs are background-only, so `execute()` returns a start receipt long before
 * the walk finishes. Tests that assert on a run's *outcome* need the report,
 * which arrives on the detached promise the tool hands to `onRunDetached`.
 *
 * This helper keeps that plumbing in one place and returns both halves:
 * `receipt` is what the model sees at call time, `report` is what it is told
 * later. Failures are normalised rather than thrown, since a start-time
 * rejection (bad script, concurrency refusal) and a run-time failure are
 * different things a test may want to distinguish.
 */

import { createGraphWorkflowTool, type GraphToolOptions } from "../../extensions/graph-tool.ts";
import type { GraphRunReport } from "../../extensions/graph-run.ts";

export interface RunGraphToolOutcome {
	/** True when execute() itself threw: the run never started. */
	failed: boolean;
	/** Text the model receives — the report when there is one, else the receipt. */
	text: string;
	/** The start receipt returned by the tool call. */
	receipt?: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
	/** The finished run's report, absent when the run never started or crashed. */
	report?: GraphRunReport;
	/** Report details when the run finished, receipt details otherwise. */
	details?: Record<string, unknown>;
	runId?: string;
}

function textOf(result: { content?: Array<{ text?: string }> } | undefined): string {
	return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

/**
 * Turns a finished report into the details shape tests assert on — the same
 * fields the tool used to return inline before runs went to the background.
 */
function detailsOf(report: GraphRunReport): Record<string, unknown> {
	return {
		runId: report.runId,
		name: report.name,
		status: report.status,
		iterations: report.iterations,
		nodeExecutions: report.nodeExecutions,
		path: report.result.path,
		durationMs: report.durationMs,
		budget: report.budget,
		state: report.result.state,
		error: report.result.error,
		savedAs: report.savedAs,
	};
}

export async function runGraphTool(
	params: Record<string, unknown>,
	options: GraphToolOptions & { cwd: string },
	ctx: Record<string, unknown> = {},
): Promise<RunGraphToolOutcome> {
	let detached: Promise<GraphRunReport | undefined> | undefined;

	const tool = createGraphWorkflowTool({
		...options,
		onRunDetached: (info) => {
			detached = info.done;
			options.onRunDetached?.(info);
		},
	});

	let receipt: RunGraphToolOutcome["receipt"];
	try {
		receipt = (await tool.execute(
			"test-call",
			params as never,
			new AbortController().signal,
			() => {},
			{ cwd: options.cwd, ...ctx } as never,
		)) as RunGraphToolOutcome["receipt"];
	} catch (error) {
		return { failed: true, text: error instanceof Error ? error.message : String(error) };
	}

	const report = detached ? await detached : undefined;

	return {
		failed: false,
		receipt,
		report,
		text: report ? report.text : textOf(receipt),
		details: report ? detailsOf(report) : (receipt?.details as Record<string, unknown> | undefined),
		runId: (receipt?.details as { runId?: string } | undefined)?.runId,
	};
}
