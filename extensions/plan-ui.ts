/**
 * /plans TUI navigator.
 *
 * Two-level view:
 *   list ──enter──▶ reader
 *        ◀──esc────
 *
 * Keys: ↑/↓ (j/k) navigate · enter/→ open plan · esc/← back · q quit
 * In reader: ↑/↓ scroll · esc/← back to list
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { listAllPlans, plansDir, type PlanMeta } from "./plan-tool.ts";

type ViewKind = "list" | "reader";

interface NavState {
	view: ViewKind;
	cursor: number;
	scroll: number;
	plans: PlanMeta[];
	selectedId: string | null;
	selectedContent: string | null;
}

function freshState(cwd: string): NavState {
	return {
		view: "list",
		cursor: 0,
		scroll: 0,
		plans: listAllPlans(cwd),
		selectedId: null,
		selectedContent: null,
	};
}

function readPlanContent(cwd: string, id: string): string {
	try {
		return fs.readFileSync(path.join(plansDir(cwd), `${id}.md`), "utf-8");
	} catch {
		return "(Could not read plan content.)";
	}
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderList(state: NavState, width: number, rows: number): string[] {
	const lines: string[] = [];
	lines.push(" 📋 Plans (.pi-workflow/plans/)");
	lines.push("─".repeat(Math.min(width, 60)));
	lines.push("");

	if (state.plans.length === 0) {
		lines.push("  No plans yet.");
		lines.push("");
		lines.push("  Use the plan tool to create one:");
		lines.push('  plan(action: "create", name: "...", content: "...")');
		return lines;
	}

	lines.push("  ↑/↓ navigate  · enter open  · r refresh  · q quit");
	lines.push("");

	const header = "  " + "ID".padEnd(30) + "  " + "NAME".padEnd(34) + "  UPDATED";
	lines.push(header);
	lines.push("  " + "─".repeat(Math.min(width - 4, 74)));

	const maxVisible = Math.max(1, rows - lines.length - 1);
	const start = Math.max(0, state.cursor - Math.floor(maxVisible / 2));
	const slice = state.plans.slice(start, start + maxVisible);

	for (let i = 0; i < slice.length; i++) {
		const p = slice[i];
		const idx = start + i;
		const selected = idx === state.cursor;
		const prefix = selected ? "▶ " : "  ";
		const idCol = truncateToWidth(p.id, 28).padEnd(30);
		const nameCol = truncateToWidth(p.name, 32).padEnd(34);
		const updated = p.updatedAt.slice(0, 10);
		const row = `${prefix}${idCol}  ${nameCol}  ${updated}`;
		lines.push(selected ? `\x1b[7m${truncateToWidth(row, width - 1)}\x1b[0m` : row);
	}

	return lines;
}

function renderReader(state: NavState, width: number, rows: number): string[] {
	const lines: string[] = [];
	const id = state.selectedId ?? "";
	lines.push(` 📄 ${id}.md`);
	lines.push("─".repeat(Math.min(width, 60)));
	lines.push("  ↑/↓ scroll  · esc/← back to list  · q quit");
	lines.push("");

	const contentLines = (state.selectedContent ?? "").split("\n");
	const maxVisible = Math.max(1, rows - lines.length - 1);
	const clampedScroll = Math.min(state.scroll, Math.max(0, contentLines.length - maxVisible));
	const slice = contentLines.slice(clampedScroll, clampedScroll + maxVisible);
	for (const l of slice) lines.push("  " + truncateToWidth(l, width - 3));

	if (contentLines.length > maxVisible) {
		const pct = Math.round((clampedScroll / Math.max(1, contentLines.length - maxVisible)) * 100);
		lines.push(`  \x1b[2m— ${pct}% (${contentLines.length} lines) —\x1b[0m`);
	}

	return lines;
}

// ── Key handling ─────────────────────────────────────────────────────────

function handleKey(
	data: string,
	state: NavState,
	cwd: string,
): { state: NavState; close: boolean } {
	const key = parseKey(data) ?? data;

	if (key === "q" || (key === "escape" && state.view === "list")) {
		return { state, close: true };
	}

	if (state.view === "list") {
		const count = state.plans.length;
		if (key === "up" || key === "k") {
			return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, close: false };
		}
		if (key === "down" || key === "j") {
			return { state: { ...state, cursor: Math.min(Math.max(0, count - 1), state.cursor + 1) }, close: false };
		}
		if ((key === "return" || key === "right") && count > 0) {
			const plan = state.plans[state.cursor];
			if (plan) {
				const content = readPlanContent(cwd, plan.id);
				return {
					state: { ...state, view: "reader", scroll: 0, selectedId: plan.id, selectedContent: content },
					close: false,
				};
			}
		}
		if (key === "r") {
			return { state: { ...state, plans: listAllPlans(cwd) }, close: false };
		}
	}

	if (state.view === "reader") {
		if (key === "escape" || key === "left") {
			return { state: { ...state, view: "list", scroll: 0, selectedId: null, selectedContent: null }, close: false };
		}
		if (key === "up" || key === "k") {
			return { state: { ...state, scroll: Math.max(0, state.scroll - 1) }, close: false };
		}
		if (key === "down" || key === "j") {
			return { state: { ...state, scroll: state.scroll + 1 }, close: false };
		}
	}

	return { state, close: false };
}

// ── Public entry point ───────────────────────────────────────────────────

export function openPlansNavigator(
	_pi: ExtensionAPI,
	cwd: string,
	ui: ExtensionUIContext,
): Promise<void> {
	let state = freshState(cwd);

	return (ui as any).custom(
		(tui: any, _theme: unknown, _keybindings: unknown, done: (r: undefined) => void) => {
			const component = {
				get focused(): boolean { return false; },
				set focused(_v: boolean) {},

				render(width: number): string[] {
					const rows: number = tui.terminal?.rows ?? 24;
					return state.view === "list"
						? renderList(state, width, rows)
						: renderReader(state, width, rows);
				},

				handleInput(data: string): void {
					const result = handleKey(data, state, cwd);
					state = result.state;
					if (result.close) {
						done(undefined);
					} else {
						tui.requestRender();
					}
				},
			};

			return component;
		},
	);
}
