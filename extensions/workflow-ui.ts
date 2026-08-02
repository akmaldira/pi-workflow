/**
 * Interactive `/workflows` TUI navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · r resume · q quit
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowManager, PersistedRun, ManagedRun } from "./workflow-manager.ts";
import type { WorkflowAgentSnapshot, AgentHistoryEntry } from "./workflow-display-types.ts";

export type ViewKind = "runs" | "phases" | "agents" | "detail";

export interface StackFrame {
	kind: ViewKind;
	cursor: number;
	runId?: string;
	phase?: string;
	agentId?: number;
}

export class NavigatorState {
	private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
	scroll = 0;
	tailing = false;
	pagerOpen = false;
	private pageSize = 5;

	private top(): StackFrame {
		return this.stack[this.stack.length - 1];
	}

	get kind(): ViewKind {
		return this.top().kind;
	}

	get cursor(): number {
		return this.top().cursor;
	}

	set cursor(val: number) {
		this.top().cursor = val;
	}

	get runId(): string | undefined {
		return this.top().runId;
	}

	get phase(): string | undefined {
		return this.top().phase;
	}

	get agentId(): number | undefined {
		return this.top().agentId;
	}

	get depth(): number {
		return this.stack.length;
	}

	clamp(count: number): void {
		const t = this.top();
		t.cursor = count <= 0 ? 0 : Math.max(0, Math.min(t.cursor, count - 1));
	}

	move(delta: number, count: number): void {
		if (this.kind === "detail") {
			this.pagerOpen = true;
			if (delta < 0) this.tailing = false;
			this.scroll = Math.max(0, this.scroll + delta);
			return;
		}
		if (count <= 0) {
			this.cursor = 0;
			return;
		}
		const t = this.top();
		t.cursor = Math.max(0, Math.min(count - 1, t.cursor + delta));
	}

	setPageSize(rows: number): void {
		this.pageSize = Math.max(1, rows);
	}

	movePage(direction: -1 | 1 | "up" | "down", count: number, pageSize?: number): void {
		const dir = direction === "up" || direction === -1 ? -1 : 1;
		const delta = dir * (pageSize ?? Math.max(1, this.pageSize - 1));
		if (this.kind === "detail") {
			this.pagerOpen = true;
			if (dir < 0) this.tailing = false;
			this.scroll = Math.max(0, this.scroll + delta);
			return;
		}
		if (count > 0) this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
	}

	jump(edge: "start" | "end" | "top" | "bottom", count: number): void {
		const isEnd = edge === "end" || edge === "bottom";
		if (this.kind === "detail") {
			this.pagerOpen = true;
			this.tailing = isEnd;
			this.scroll = isEnd ? Number.MAX_SAFE_INTEGER : 0;
			return;
		}
		this.cursor = !isEnd || count <= 0 ? 0 : count - 1;
	}

	openPager(): boolean {
		if (this.kind !== "detail") return false;
		if (!this.pagerOpen) {
			this.pagerOpen = true;
			this.scroll = 0;
		}
		return true;
	}

	togglePager(): boolean {
		if (this.kind !== "detail") return false;
		if (!this.pagerOpen) return this.openPager();
		this.pagerOpen = false;
		this.scroll = 0;
		this.tailing = false;
		return false;
	}

	toggleTail(): boolean {
		if (this.kind !== "detail") return false;
		this.pagerOpen = true;
		this.tailing = !this.tailing;
		if (this.tailing) this.scroll = Number.MAX_SAFE_INTEGER;
		return this.tailing;
	}

	drill(model: NavigatorModel): boolean {
		const t = this.top();
		if (t.kind === "runs") {
			const runs = model.runs();
			if (t.cursor < runs.length) {
				const run = runs[t.cursor];
				if (!run) return false;
				this.stack.push({ kind: "phases", cursor: 0, runId: run.runId });
				return true;
			}
			return false;
		}

		if (t.kind === "phases" && t.runId) {
			const phases = model.phases(t.runId);
			const ph = phases[t.cursor];
			if (!ph) return false;
			this.stack.push({ kind: "agents", cursor: 0, runId: t.runId, phase: ph.title });
			return true;
		}

		if (t.kind === "agents" && t.runId && t.phase) {
			const agents = model.agents(t.runId, t.phase);
			const ag = agents[t.cursor];
			if (!ag) return false;
			this.scroll = 0;
			this.tailing = false;
			this.pagerOpen = false;
			this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
			return true;
		}

		return false;
	}

	back(): boolean {
		if (this.kind === "detail" && this.pagerOpen) {
			this.pagerOpen = false;
			this.scroll = 0;
			this.tailing = false;
			return true;
		}
		if (this.stack.length <= 1) return false;
		this.stack.pop();
		this.scroll = 0;
		this.tailing = false;
		this.pagerOpen = false;
		return true;
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

function asText(v: unknown): string {
	return typeof v === "string" ? v : String(v ?? "");
}

function agentPhaseKey(a: WorkflowAgentSnapshot): string {
	return a.phase != null && String(a.phase).trim() ? asText(a.phase) : "(no phase)";
}

export class NavigatorModel {
	constructor(private manager: WorkflowManager) {}

	runs(): RunRow[] {
		return this.manager.listRuns().map((r) => {
			const agents = r.agents || [];
			const doneCount = agents.filter((a) => a.status === "done").length;
			return {
				runId: r.runId,
				name: asText(r.workflowName),
				status: asText(r.status),
				done: doneCount,
				total: agents.length,
				totalTokens: r.totalTokens || 0,
				durationMs: r.durationMs || 0,
			};
		});
	}

	phases(runId: string): PhaseRow[] {
		const live = this.manager.getRun(runId);
		const snap = live
			? live.snapshot
			: (() => {
					const p = this.manager.listRuns().find((r) => r.runId === runId);
					return p ? { phases: (p as any).phases || [], agents: p.agents || [] } : undefined;
				})();

		if (!snap) return [];

		const rawPhases = Array.isArray(snap.phases)
			? snap.phases.map((p: any) => (typeof p === "string" ? p : p.title || ""))
			: [];
		const order: string[] = rawPhases.map(asText).filter(Boolean);
		const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
		const agents = Array.isArray(snap.agents) ? snap.agents : [];

		for (const a of agents) {
			const key = agentPhaseKey(a);
			if (!byPhase.has(key)) byPhase.set(key, []);
			byPhase.get(key)?.push(a);
			if (!order.includes(key)) order.push(key);
		}

		// Fallback: if no phases pre-declared and no agents yet, return a default phase row
		if (order.length === 0) {
			order.push("(no phase)");
		}

		return order.map((title) => {
			const ags = byPhase.get(title) ?? [];
			const done = ags.filter((a) => a.status === "done").length;
			const tokens = ags.reduce((sum, a) => sum + (a.outputTokens || 0), 0);
			return {
				title,
				done,
				total: ags.length,
				tokens,
			};
		});
	}

	agents(runId: string, phase: string): WorkflowAgentSnapshot[] {
		const live = this.manager.getRun(runId);
		const snap = live
			? live.snapshot
			: (() => {
					const p = this.manager.listRuns().find((r) => r.runId === runId);
					return p ? { agents: p.agents || [] } : undefined;
				})();

		if (!snap || !Array.isArray(snap.agents)) return [];
		return snap.agents.filter((a) => agentPhaseKey(a) === phase);
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

export type NavAction =
	| { type: "move"; delta: number }
	| { type: "page"; direction: -1 | 1 }
	| { type: "jump"; edge: "start" | "end" }
	| { type: "toggleTail" }
	| { type: "togglePager" }
	| { type: "openPager" }
	| { type: "drill" }
	| { type: "back" }
	| { type: "close" }
	| { type: "pause" }
	| { type: "stop" }
	| { type: "resume" }
	| { type: "none" };

export function keyToAction(keyStr: string, kind: ViewKind): NavAction {
	const key = parseKey(keyStr);
	const name = key?.name || keyStr;

	switch (name) {
		case "up":
		case "k":
			return { type: "move", delta: -1 };
		case "down":
		case "j":
			return { type: "move", delta: 1 };
		case "pageUp":
		case "ctrl+u":
		case "ctrl+b":
			return { type: "page", direction: -1 };
		case "pageDown":
		case "ctrl+d":
		case "ctrl+f":
			return { type: "page", direction: 1 };
		case "home":
		case "g":
			return { type: "jump", edge: "start" };
		case "end":
		case "G":
		case "shift+g":
			return { type: "jump", edge: "end" };
		case "t":
			return kind === "detail" ? { type: "toggleTail" } : { type: "none" };
		case "return":
		case "enter":
			if (kind === "detail") return { type: "togglePager" };
			return { type: "drill" };
		case "right":
		case "l":
			if (kind === "detail") return { type: "openPager" };
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
		default:
			return { type: "none" };
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Two-Pane Split Layout Renderer (Claude Code Parity)
// ───────────────────────────────────────────────────────────────────────────

const BX = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", tj: "┬", bj: "┴" } as const;
const CARET = "›";
const DOT = "●";

export function renderNavigatorText(
	state: NavigatorState,
	model: NavigatorModel,
	width = 80,
	viewportRows = 24,
): string[] {
	const lines: string[] = [];
	state.setPageSize(Math.max(1, viewportRows - 5));

	if (state.kind === "runs") {
		const runs = model.runs();
		state.clamp(runs.length);

		lines.push("┌─ Workflows ────────────────────────────────────────────────────────────┐");
		lines.push("│ ↑/↓ select · Enter open · p pause · x stop · r resume · q quit         │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		if (runs.length === 0) {
			lines.push("│   (No active or recorded workflow runs found)                          │");
		} else {
			runs.forEach((r, idx) => {
				const isSelected = idx === state.cursor;
				const prefix = isSelected ? `${CARET} ` : "  ";
				const icon = statusIcon(r.status);
				const lineStr = `${prefix}${icon} ${r.name} (${r.runId.slice(0, 8)}) — ${r.done}/${r.total} agents · ${r.totalTokens}t`;
				lines.push(`│ ${padRight(truncateToWidth(lineStr, width - 4), width - 4)} │`);
			});
		}
		lines.push("└────────────────────────────────────────────────────────────────────────┘");
	} else if ((state.kind === "phases" || state.kind === "agents") && state.runId) {
		const phases = model.phases(state.runId);
		const inAgents = state.kind === "agents";

		let selPhaseIdx = inAgents ? phases.findIndex((p) => p.title === state.phase) : state.cursor;
		if (selPhaseIdx < 0) selPhaseIdx = 0;
		const selPhase = phases[selPhaseIdx];
		const agents = selPhase ? model.agents(state.runId, selPhase.title) : [];

		if (inAgents) state.clamp(agents.length);
		else state.clamp(phases.length);

		const leftW = Math.max(18, Math.min(30, Math.floor(width * 0.35)));
		const rightW = Math.max(20, width - leftW);
		const leftInner = leftW - 2;
		const rightInner = rightW - 2;

		lines.push(
			`┌─ Phases ${"─".repeat(leftInner - 8)}┬─ ${truncateToWidth(selPhase ? selPhase.title : "Agents", rightInner - 4)} ${"─".repeat(Math.max(0, rightInner - 12))}┐`,
		);

		const maxRows = Math.max(phases.length, agents.length, 3);
		for (let r = 0; r < maxRows; r++) {
			let leftContent = " ".repeat(leftInner);
			if (r < phases.length) {
				const p = phases[r];
				const selected = !inAgents && r === state.cursor;
				const marker = selected ? `${CARET} ` : "  ";
				leftContent = padRight(truncateToWidth(`${marker}${p.title} (${p.done}/${p.total})`, leftInner), leftInner);
			}

			let rightContent = " ".repeat(rightInner);
			if (r < agents.length) {
				const a = agents[r];
				const selected = inAgents && r === state.cursor;
				const marker = selected ? `${CARET} ` : "  ";
				const dot = agentStatusIcon(a.status);
				const tokens = a.outputTokens ? ` ${a.outputTokens}t` : "";
				rightContent = padRight(
					truncateToWidth(`${marker}${dot} #${a.id} ${asText(a.label)}${tokens}`, rightInner),
					rightInner,
				);
			} else if (r === 0 && agents.length === 0) {
				rightContent = padRight(truncateToWidth("  (no agents in phase)", rightInner), rightInner);
			}

			lines.push(`│${leftContent}│${rightContent}│`);
		}

		lines.push(`└${"─".repeat(leftInner)}┴${"─".repeat(rightInner)}┘`);
		lines.push(
			inAgents
				? "  Enter open detail · Esc back to phases · q quit"
				: "  Enter select phase · Esc back to runs · q quit",
		);
	} else if (state.kind === "detail" && state.runId && state.agentId !== undefined) {
		const agent = model.agentDetail(state.runId, state.agentId);
		const innerWidth = width - 4;

		lines.push(`┌─ Agent #${state.agentId} Detail ──────────────────────────────────────────────────┐`);
		lines.push("│ Enter toggle pager · t toggle tail · Esc back · q quit                 │");
		lines.push("├────────────────────────────────────────────────────────────────────────┤");

		if (!agent) {
			lines.push("│   (Agent details unavailable)                                          │");
		} else {
			const bodyLines: string[] = [];
			bodyLines.push(`Label:  ${asText(agent.label)}`);
			bodyLines.push(`Status: ${agentStatusIcon(agent.status)} ${asText(agent.status)}`);
			if (agent.model) bodyLines.push(`Model:  ${asText(agent.model)}`);
			if (agent.outputTokens) bodyLines.push(`Tokens: ${agent.outputTokens}`);
			bodyLines.push("");
			bodyLines.push("--- Prompt ---");
			bodyLines.push(asText(agent.prompt || "(none)"));
			bodyLines.push("");

			if (state.pagerOpen) {
				bodyLines.push("--- Output / Result ---");
				bodyLines.push(agent.error ? `Error: ${asText(agent.error)}` : asText(agent.resultPreview || "(running...)"));

				if (agent.history && agent.history.length > 0) {
					bodyLines.push("");
					bodyLines.push("--- History Stream ---");
					for (const entry of agent.history) {
						if (entry.kind === "toolCall") {
							bodyLines.push(`[toolCall] ${entry.toolName}: ${entry.args}`);
						} else if (entry.role === "tool") {
							bodyLines.push(`[toolResult] ${entry.toolName}: ${entry.text}`);
							if (entry.diff) bodyLines.push(`  Diff: ${entry.diff}`);
						} else {
							bodyLines.push(`[${entry.role}] ${entry.text}`);
						}
					}
				}
			} else {
				bodyLines.push("--- Output Snippet ---");
				bodyLines.push(agent.error ? `Error: ${asText(agent.error)}` : asText(agent.resultPreview || "(running...)"));
				bodyLines.push("  … Press Enter to open full pager & stream history");
			}

			const viewportCap = Math.max(1, viewportRows - 6);
			const maxScroll = Math.max(0, bodyLines.length - viewportCap);
			if (state.tailing) state.scroll = maxScroll;
			state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);

			const visibleBody = bodyLines.slice(state.scroll, state.scroll + viewportCap);
			for (const line of visibleBody) {
				lines.push(`│ ${padRight(truncateToWidth(line, innerWidth), innerWidth)} │`);
			}
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

			// 125ms Debounce timer for high-frequency history updates
			let historyRenderTimer: ReturnType<typeof setTimeout> | undefined;
			const onHistoryEvent = () => {
				if (historyRenderTimer) return;
				historyRenderTimer = setTimeout(() => {
					historyRenderTimer = undefined;
					rerender();
				}, 125);
			};

			const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
			const onEvent = () => rerender();
			for (const ev of events) manager.on(ev, onEvent);
			manager.on("agentHistory", onHistoryEvent);

			const cleanup = () => {
				for (const ev of events) manager.off(ev, onEvent);
				manager.off("agentHistory", onHistoryEvent);
				if (historyRenderTimer) clearTimeout(historyRenderTimer);
			};

			return {
				render(width: number): string[] {
					return renderNavigatorText(state, model, width, tui.terminal.rows);
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
							state.movePage(action.direction || 1, count);
							rerender();
							break;
						case "jump":
							state.jump(action.edge || "start", count);
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
						case "togglePager":
							state.togglePager();
							rerender();
							break;
						case "openPager":
							state.openPager();
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
