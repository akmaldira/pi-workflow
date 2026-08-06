/**
 * Real-time workflow display & rendering for TUI monitoring.
 *
 * Provides:
 * - Snapshot creation and updates
 * - Text rendering for console/TUI output
 * - Progress tracking and statistics
 * - Compact and detailed display modes
 */

import type {
	WorkflowSnapshot,
	WorkflowAgentSnapshot,
	WorkflowStats,
	WorkflowDisplayOptions,
} from "./workflow-display-types.ts";
import type { WorkflowMeta } from "./workflow-display-types.ts";

/**
 * Create a new workflow snapshot.
 */
export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
	return {
		meta,
		status: "running",
		phases: (meta.phases || []).map((phase, index) => ({
			title: phase.title,
			index,
			status: "pending" as const,
			agents: [],
		})),
		agents: [],
		totalAgents: 0,
		totalTokens: 0,
		durationMs: 0,
		logs: [],
	};
}

/**
 * Record an agent's execution in the snapshot.
 */
export function recordAgent(
	snapshot: WorkflowSnapshot,
	phaseIndex: number,
	agent: WorkflowAgentSnapshot,
): void {
	snapshot.agents.push(agent);
	snapshot.totalAgents++;

	if (snapshot.phases[phaseIndex]) {
		snapshot.phases[phaseIndex].agents.push(agent);
		if (snapshot.phases[phaseIndex].status === "pending") {
			snapshot.phases[phaseIndex].status = "active";
		}
	}

	if (agent.outputTokens) {
		snapshot.totalTokens += agent.outputTokens;
	}
}

/**
 * Update a phase's status.
 */
export function updatePhaseStatus(
	snapshot: WorkflowSnapshot,
	phaseIndex: number,
	status: "pending" | "active" | "completed",
): void {
	if (snapshot.phases[phaseIndex]) {
		snapshot.phases[phaseIndex].status = status;
	}
}

/**
 * Finalize the snapshot.
 */
export function finalizeSnapshot(
	snapshot: WorkflowSnapshot,
	result: unknown,
	error?: string,
	durationMs?: number,
): void {
	snapshot.status = error ? "error" : "completed";
	if (error) {
		snapshot.error = error;
	} else {
		snapshot.result = result;
	}
	if (durationMs !== undefined) {
		snapshot.durationMs = durationMs;
	}

	// Mark all phases as completed
	for (const phase of snapshot.phases) {
		if (phase.status !== "pending") {
			phase.status = "completed";
		}
	}
}

/**
 * Get statistics from a snapshot.
 */
export function getSnapshotStats(snapshot: WorkflowSnapshot): WorkflowStats {
	const completed = snapshot.agents.filter((a) => a.status === "done").length;
	const failed = snapshot.agents.filter((a) => a.status === "error").length;
	const totalDuration = snapshot.durationMs;
	const avgDuration = snapshot.totalAgents > 0 ? totalDuration / snapshot.totalAgents : 0;
	const avgTokens = snapshot.totalAgents > 0 ? snapshot.totalTokens / snapshot.totalAgents : 0;

	return {
		totalAgents: snapshot.totalAgents,
		completedAgents: completed,
		failedAgents: failed,
		totalTokens: snapshot.totalTokens,
		totalDurationMs: totalDuration,
		averageTokensPerAgent: avgTokens,
		averageDurationPerAgent: avgDuration,
	};
}

/**
 * Render workflow snapshot as text for console output.
 */
export function renderWorkflowText(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string {
	const lines: string[] = [];
	const maxAgents = options.maxAgents ?? 3;
	const showTokens = options.showTokens ?? true;
	const showModel = options.showModel ?? false;
	const compact = options.compact ?? false;

	// Header
	const status = statusIcon(snapshot.status);
	const title = `${status} Workflow: ${snapshot.meta.name || "unnamed"}`;
	// Counted as steps: a graph that loops runs the same agent more than
	// once, so "5 agents" would overstate how many distinct participants took
	// part. Phased runs execute each agent once, so the two coincide there.
	const unit = snapshot.totalAgents === 1 ? "step" : "steps";
	const statsStr = compact
		? `${snapshot.totalAgents} ${unit}, ${snapshot.totalTokens}t`
		: `(${snapshot.totalAgents} ${unit}, ${snapshot.totalTokens} tokens used)`;

	lines.push(`◆ ${title} ${statsStr}`);

	if (snapshot.meta.description) {
		lines.push(`  ${snapshot.meta.description}`);
	}

	// Phases
	if (!compact) {
		for (const phase of snapshot.phases) {
			const phaseStatus = phaseStatusIcon(phase.status);
			const title = phase.title || `Phase ${phase.index + 1}`;
			const count = phase.agents.length;
			lines.push(`  ${phaseStatus} ${title} (${count} agents)`);

			// Show last N agents
			const visible = phase.agents.slice(-maxAgents);
			for (const agent of visible) {
				const agentStatus = agentStatusIcon(agent.status);
				const label = truncate(agent.label, 40);
				const tokens = showTokens && agent.outputTokens ? ` · ${agent.outputTokens}t` : "";
				const model = showModel && agent.model ? ` · ${agent.model}` : "";
				const duration = agent.durationMs ? ` · ${(agent.durationMs / 1000).toFixed(1)}s` : "";

				lines.push(`    ${agentStatus} ${label}${tokens}${model}${duration}`);
			}

			if (phase.agents.length > visible.length) {
				lines.push(`    … ${phase.agents.length - visible.length} earlier agents`);
			}
		}
	} else {
		// Compact mode: one line per phase
		for (const phase of snapshot.phases) {
			const phaseStatus = phaseStatusIcon(phase.status);
			const title = phase.title || `Phase ${phase.index + 1}`;
			const done = phase.agents.filter((a) => a.status === "done").length;
			const failed = phase.agents.filter((a) => a.status === "error").length;

			lines.push(`  ${phaseStatus} ${title} ${done}/${phase.agents.length}${failed ? ` · ${failed} errors` : ""}`);
		}
	}

	// Final result
	if (snapshot.status !== "running") {
		lines.push("");
		if (snapshot.error) {
			lines.push(`  ✗ Error: ${snapshot.error}`);
		} else {
			lines.push(`  ✓ Completed in ${(snapshot.durationMs / 1000).toFixed(1)}s`);
		}
	}

	return lines.join("\n");
}

/**
 * Render as array of lines (for TUI panes).
 */
export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
	return renderWorkflowText(snapshot, options).split("\n");
}

/**
 * Preview/truncate a value for display.
 */
export function previewValue(value: unknown, maxLen: number = 60): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

// Helper functions

function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "▶";
		case "completed":
			return "✓";
		case "error":
			return "✗";
		case "cancelled":
			return "◆";
		default:
			return "?";
	}
}

function phaseStatusIcon(status: string): string {
	switch (status) {
		case "pending":
			return "●";
		case "active":
			return "▶";
		case "completed":
			return "✓";
		default:
			return "?";
	}
}

function agentStatusIcon(status: string): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "cached":
			return "⟳";
		case "skipped":
			return "-";
		default:
			return "?";
	}
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}
