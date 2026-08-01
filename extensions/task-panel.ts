/**
 * Background-run UX task panel:
 *  - Displays a live status bar under the chat input while dynamic workflows run.
 *  - Automatically updates as agents start, complete, or report progress.
 *  - Delivers a human-readable summary back to the conversation when background runs finish.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager, ManagedRun } from "./workflow-manager.ts";
import { renderWorkflowText } from "./workflow-display.ts";

export interface TaskPanelOptions {
	cwd?: string;
}

/**
 * Register background task panel listeners and status line updates.
 */
export function registerTaskPanel(
	pi: ExtensionAPI,
	manager: WorkflowManager,
	ui: ExtensionUIContext,
	_opts: TaskPanelOptions = {},
): () => void {
	const activeKeys = new Set<string>();

	const updateStatus = (runId: string) => {
		const run = manager.getRun(runId);
		if (!run) return;

		const key = `wf:${runId}`;
		if (run.status === "running") {
			activeKeys.add(key);
			const total = run.snapshot.agents.length;
			const done = run.snapshot.agents.filter((a) => a.status === "done").length;
			const running = run.snapshot.agents.filter((a) => a.status === "running").length;
			const errors = run.snapshot.agents.filter((a) => a.status === "error").length;

			const statusText = `▶ Workflow "${run.snapshot.meta.name}": ${done}/${total} done${running ? `, ${running} running` : ""}${errors ? `, ${errors} err` : ""} · ${run.snapshot.totalTokens}t`;
			ui.setStatus(key, statusText);
		} else {
			ui.setStatus(key, undefined);
			activeKeys.delete(key);
		}
	};

	const onRunEvent = (e: { runId: string }) => {
		if (e?.runId) updateStatus(e.runId);
	};

	const onComplete = (e: { runId: string; result?: unknown; error?: string }) => {
		if (!e?.runId) return;
		updateStatus(e.runId);

		const run = manager.getRun(e.runId);
		if (!run) return;

		const text = deliverResultSummary(run, e.error);
		void pi.sendMessage({
			customType: "workflows",
			content: text,
			display: true,
		});
	};

	const events = ["agentStart", "agentEnd", "phase", "log", "paused", "resumed"];
	for (const ev of events) {
		manager.on(ev, onRunEvent);
	}
	manager.on("complete", onComplete);
	manager.on("error", onComplete);
	manager.on("stopped", onComplete);

	return () => {
		for (const ev of events) {
			manager.off(ev, onRunEvent);
		}
		manager.off("complete", onComplete);
		manager.off("error", onComplete);
		manager.off("stopped", onComplete);

		for (const key of activeKeys) {
			ui.setStatus(key, undefined);
		}
		activeKeys.clear();
	};
}

/**
 * Format a completed workflow run result for conversation delivery.
 */
export function deliverResultSummary(run: ManagedRun, error?: string): string {
	const name = run.snapshot.meta.name || "workflow";
	const duration = (run.snapshot.durationMs / 1000).toFixed(1);
	const agentsCount = run.snapshot.agents.length;
	const tokens = run.snapshot.totalTokens;

	if (error) {
		return `✗ Background workflow "${name}" failed after ${duration}s (${agentsCount} agents, ${tokens}t):\n\nError: ${error}`;
	}

	const summaryText = renderWorkflowText(run.snapshot, { compact: true });
	return `✓ Background workflow "${name}" completed in ${duration}s (${agentsCount} agents, ${tokens}t).\n\n${summaryText}`;
}
