/**
 * Interactive `/workflows` TUI navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · r resume · q quit
 */

import { type ExtensionAPI, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowManager, PersistedRun, ManagedRun } from "./workflow-manager.ts";
import type { WorkflowAgentSnapshot } from "./workflow-display-types.ts";

export type ViewKind = "runs" | "phases" | "agents" | "detail";

export interface Action {
	type:
		| "move"
		| "page"
		| "jump"
		| "drill"
		| "back"
		| "close"
		| "stop"
		| "pause"
		| "resume"
		| "toggleTail"
		| "none";
	delta?: number;
	direction?: "up" | "down";
	edge?: "top" | "bottom";
}

export class NavigatorState {
	kind: ViewKind = "runs";
	cursor = 0;
	runId?: string;
	phase?: string;
	agentId?: number;
	tailOutput = true;

	private historyStack: Array<{ kind: ViewKind; cursor: number; runId?: string; phase?: string; agentId?: number }> = [];

	move(delta: number, maxCount: number): void {
		if (maxCount <= 0) {
			this.cursor = 0;
			return;
		}
		this.cursor = Math.max(0, Math.min(maxCount - 1, this.cursor + delta));
	}

	movePage(direction: "up" | "down", maxCount: number, pageSize = 5): void {
		const delta = direction === "up" ? -pageSize : pageSize;
		this.move(delta, maxCount);
	}

	jump(edge: "top" | "bottom", maxCount: number): void {
		if (maxCount <= 0) {
			this.cursor = 0;
			return;
		}
		this.cursor = edge === "top" ? 0 : maxCount - 1;
	}

	toggleTail(): void {
		this.tailOutput = !this.tailOutput;
	}

	drill(model: NavigatorModel): boolean {
		if (this.kind === "runs") {
			const runs = model.runs();
			const selected = runs[this.cursor];
			if (!selected) return false;

			this.pushStack();
			this.kind = "phases";
			this.runId = selected.runId;
			this.cursor = 0;
			return true;
		}

		if (this.kind === "phases" && this.runId) {
			const phases = model.phases(this.runId);
			const selected = phases[this.cursor];
			if (!selected) return false;

			this.pushStack();
			this.kind = "agents";
			this.phase = selected.title;
			this.cursor = 0;
			return true;
		}

		if (this.kind === "agents" && this.runId && this.phase) {
			const agents = model.agents(this.runId, this.phase);
			const selected = agents[this.cursor];
			if (!selected) return false;

			this.pushStack();
			this.kind = "detail";
			this.agentId = selected.id;
			this.cursor = 0;
			return true;
		}

		return false;
	}

	back(): boolean {
		const prev = this.historyStack.pop();
		if (!prev) return false;

		this.kind = prev.kind;
		this.cursor = prev.cursor;
		this.runId = prev.runId;
		this.phase = prev.phase;
		this.agentId = prev.agentId;
		return true;
	}

	private pushStack(): void {
		this.historyStack.push({
			kind: this.kind,
			cursor: this.cursor,
			runId: this.runId,
			phase: this.phase,
			agentId: this.agentId,
		});
	}
}

export interface RunRow {
	runId: string;
	name: string;
	status: string;
	done: number;
	total: number;
	totalTokens: number;
	durationMs: number;
}

export interface PhaseRow {
	title: string;
	done: number;
	total: number;
	tokens: number;
}

export class NavigatorModel {
	constructor(private manager: WorkflowManager) {}

	runs(): RunRow[] {
		return this.manager.listRuns().map((r) => {
			const agents = r.agents || [];
			const doneCount = agents.filter((a) => a.status === "done").length;
			return {
				runId: r.runId,
				name: r.workflowName,
				status: r.status,
				done: doneCount,
				total: agents.length,
				totalTokens: r.totalTokens || 0,
				durationMs: r.durationMs || 0,
			};
		});
	}

	phases(runId: string): PhaseRow[] {
		const live = this.manager.getRun(runId);
		if (live) {
			return live.snapshot.phases.map((p) => {
				const done = p.agents.filter((a) => a.status === "done").length;
				const tokens = p.agents.reduce((sum, a) => sum + (a.outputTokens || 0), 0);
				return {
					title: p.title || `Phase ${p.index + 1}`,
					done,
					total: p.agents.length,
					tokens,
				};
			});
		}

		const persisted = this.manager.listRuns().find((r) => r.runId === runId);
		if (!persisted) return [];

		// Group agents by phase if available
		const byPhase = new Map<string, { done: number; total: number; tokens: number }>();
		for (const agent of persisted.agents) {
			const phaseName = agent.phase || "Phase 1";
			const entry = byPhase.get(phaseName) || { done: 0, total: 0, tokens: 0 };
			entry.total++;
			if (agent.status === "done") entry.done++;
			entry.tokens += agent.outputTokens || 0;
			byPhase.set(phaseName, entry);
		}

		return Array.from(byPhase.entries()).map(([title, stats]) => ({
			title,
			done: stats.done,
			total: stats.total,
			tokens: stats.tokens,
		}));
	}

	agents(runId: string, phase: string): WorkflowAgentSnapshot[] {
		const live = this.manager.getRun(runId);
		if (live) {
			return live.snapshot.agents.filter((a) => (a.phase || "Phase 1") === phase || live.snapshot.phases.length <= 1);
		}

		const persisted = this.manager.listRuns().find((r) => r.runId === runId);
		if (!persisted) return [];

		return (persisted.agents || []).filter((a) => (a.phase || "Phase 1") === phase || true);
	}

	agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined {
		const live = this.manager.getRun(runId);
		if (live) {
			return live.snapshot.agents.find((a) => a.id === agentId);
		}

		const persisted = this.manager.listRuns().find((r) => r.runId === runId);
		return persisted?.agents.find((a) => a.id === agentId);
	}
}

export function keyToAction(keyStr: string, kind: ViewKind): Action {
	const key = parseKey(keyStr);
	const name = key?.name || keyStr;

	switch (name) {
		case "up":
		case "k":
			return { type: "move", delta: -1 };
		case "down":
		case "j":
			return { type: "move", delta: 1 };
		case "pageup":
			return { type: "page", direction: "up" };
		case "pagedown":
			return { type: "page", direction: "down" };
		case "home":
			return { type: "jump", edge: "top" };
		case "end":
			return { type: "jump", edge: "bottom" };
		case "return":
		case "enter":
		case "right":
		case "l":
			return { type: "drill" };
		case "escape":
		case "esc":
		case "left":
		case "h":
			return { type: "back" };
		case "q":
			return { type: "close" };
		case "p":
			return { type: "pause" };
		case "x":
			return { type: "stop" };
		case "r":
			return { type: "resume" };
		case "t":
			return { type: "toggleTail" };
		default:
			return { type: "none" };
	}
}

export function renderNavigatorText(state: NavigatorState, model: NavigatorModel, width = 80): string[] {
	const lines: string[] = [];
	const innerWidth = Math.max(20, width - 4);

	if (state.kind === "runs") {
		lines.push("┌─ Workflow Runs ────────────────────────────────────────────────────────┐");
		lines.push("│ ↑/↓ select · Enter drill in · p pause · x stop · r resume · q quit    │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		const runs = model.runs();
		if (runs.length === 0) {
			lines.push("│   (No active or recorded workflow runs found)                          │");
		} else {
			runs.forEach((r, idx) => {
				const isSelected = idx === state.cursor;
				const prefix = isSelected ? "> " : "  ";
				const icon = statusIcon(r.status);
				const lineStr = `${prefix}${icon} ${r.name} (${r.runId.slice(0, 8)}) — ${r.done}/${r.total} agents · ${r.totalTokens}t`;
				lines.push(`│ ${padRight(truncateToWidth(lineStr, innerWidth), innerWidth)} │`);
			});
		}
		lines.push("└────────────────────────────────────────────────────────────────────────┘");
	} else if (state.kind === "phases" && state.runId) {
		const phases = model.phases(state.runId);
		lines.push(`┌─ Phases for Run ${state.runId.slice(0, 8)} ──────────────────────────────────────────┐`);
		lines.push("│ ↑/↓ select · Enter view agents · Esc back                              │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		if (phases.length === 0) {
			lines.push("│   (No phases found for this run)                                       │");
		} else {
			phases.forEach((p, idx) => {
				const isSelected = idx === state.cursor;
				const prefix = isSelected ? "> " : "  ";
				const lineStr = `${prefix}Phase: ${p.title} — ${p.done}/${p.total} done · ${p.tokens}t`;
				lines.push(`│ ${padRight(truncateToWidth(lineStr, innerWidth), innerWidth)} │`);
			});
		}
		lines.push("└────────────────────────────────────────────────────────────────────────┘");
	} else if (state.kind === "agents" && state.runId && state.phase) {
		const agents = model.agents(state.runId, state.phase);
		lines.push(`┌─ Agents in ${state.phase} ───────────────────────────────────────────┐`);
		lines.push("│ ↑/↓ select · Enter view detail · Esc back                              │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		if (agents.length === 0) {
			lines.push("│   (No agents found in this phase)                                      │");
		} else {
			agents.forEach((a, idx) => {
				const isSelected = idx === state.cursor;
				const prefix = isSelected ? "> " : "  ";
				const icon = agentStatusIcon(a.status);
				const tokens = a.outputTokens ? ` · ${a.outputTokens}t` : "";
				const duration = a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)}s` : "";
				const lineStr = `${prefix}${icon} #${a.id} ${a.label}${tokens}${duration}`;
				lines.push(`│ ${padRight(truncateToWidth(lineStr, innerWidth), innerWidth)} │`);
			});
		}
		lines.push("└────────────────────────────────────────────────────────────────────────┘");
	} else if (state.kind === "detail" && state.runId && state.agentId !== undefined) {
		const agent = model.agentDetail(state.runId, state.agentId);
		lines.push(`┌─ Agent #${state.agentId} Detail ──────────────────────────────────────────────────┐`);
		lines.push("│ t toggle tail · Esc back · q quit                                     │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		if (!agent) {
			lines.push("│   (Agent details unavailable)                                          │");
		} else {
			lines.push(`│ Label:  ${truncateToWidth(agent.label, innerWidth - 10)} │`);
			lines.push(`│ Status: ${agentStatusIcon(agent.status)} ${agent.status} │`);
			if (agent.model) lines.push(`│ Model:  ${agent.model} │`);
			if (agent.outputTokens) lines.push(`│ Tokens: ${agent.outputTokens} │`);
			lines.push("├────────────────────────────────────────────────────────────────────────┤");
			lines.push("│ Prompt:                                                                │");
			lines.push(`│   ${truncateToWidth(agent.prompt || "(none)", innerWidth - 4)} │`);
			lines.push("├────────────────────────────────────────────────────────────────────────┤");
			lines.push("│ Output / Result:                                                       │");
			const outputText = agent.error ? `Error: ${agent.error}` : agent.resultPreview || "(running...)";
			lines.push(`│   ${truncateToWidth(outputText, innerWidth - 4)} │`);
		}
		lines.push("└────────────────────────────────────────────────────────────────────────┘");
	}

	return lines;
}

export function openWorkflowNavigator(
	pi: ExtensionAPI,
	manager: WorkflowManager,
	ui: ExtensionUIContext,
): Promise<void> {
	const model = new NavigatorModel(manager);
	const state = new NavigatorState();

	return ui.custom<void>(
		(tui: TUI, theme: Theme, _keybindings, done: (r: undefined) => void) => {
			const rerender = () => tui.requestRender();

			const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
			const onEvent = () => rerender();
			for (const ev of events) manager.on(ev, onEvent);

			const cleanup = () => {
				for (const ev of events) manager.off(ev, onEvent);
			};

			return {
				render(width: number): string[] {
					return renderNavigatorText(state, model, width);
				},

				handleInput(data: string): void {
					const runs = model.runs();
					const count =
						state.kind === "runs"
							? runs.length
							: state.kind === "phases" && state.runId
								? model.phases(state.runId).length
								: state.kind === "agents" && state.runId && state.phase
									? model.agents(state.runId, state.phase).length
									: 1;

					const action = keyToAction(data, state.kind);

					switch (action.type) {
						case "move":
							state.move(action.delta || 0, count);
							rerender();
							break;
						case "page":
							state.movePage(action.direction || "down", count);
							rerender();
							break;
						case "jump":
							state.jump(action.edge || "top", count);
							rerender();
							break;
						case "drill":
							state.drill(model);
							rerender();
							break;
						case "back":
							if (!state.back()) {
								cleanup();
								done(undefined);
							} else {
								rerender();
							}
							break;
						case "close":
							cleanup();
							done(undefined);
							break;
						case "stop":
							if (state.runId) manager.stopRun(state.runId);
							rerender();
							break;
						case "pause":
							if (state.runId) manager.pauseRun(state.runId);
							rerender();
							break;
						case "resume":
							if (state.runId) manager.resumeRun(state.runId);
							rerender();
							break;
						case "toggleTail":
							state.toggleTail();
							rerender();
							break;
					}
				},

				invalidate(): void {
					rerender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				maxHeight: "85%",
			},
		},
	);
}

function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "▶";
		case "paused":
			return "⏸";
		case "completed":
			return "✓";
		case "stopped":
		case "cancelled":
			return "⊘";
		case "error":
			return "✗";
		default:
			return "·";
	}
}

function agentStatusIcon(status: string): string {
	switch (status) {
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "cached":
			return "⟳";
		default:
			return "○";
	}
}

function padRight(str: string, len: number): string {
	const w = visibleWidth(str);
	return w >= len ? str : str + " ".repeat(len - w);
}
