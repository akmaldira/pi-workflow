/**
 * Shared WorkflowManager for tracking active and persisted workflow runs.
 * Emits events for TUI display and `/workflows` navigation.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowSnapshot, WorkflowAgentSnapshot, AgentHistoryEntry } from "./workflow-display-types.ts";
import type { WorkflowMeta } from "./workflow.ts";

export type RunStatus = "running" | "paused" | "completed" | "error" | "stopped";

export interface ManagedRun {
	runId: string;
	status: RunStatus;
	snapshot: WorkflowSnapshot;
	startedAt: number;
	updatedAt: number;
	journalDir?: string;
	abortController?: AbortController;
	/**
	 * The raw workflow script source and cwd it ran in, kept in-memory only
	 * (never persisted to the journal) so the /workflows TUI navigator can
	 * offer "save this workflow for reuse" without the caller having to
	 * re-supply the script. Only available for runs still tracked in this
	 * process (i.e. not runs restored from a journal after a restart).
	 */
	script?: string;
	cwd?: string;
}

export interface PersistedRun {
	runId: string;
	workflowName: string;
	status: RunStatus;
	agents: WorkflowAgentSnapshot[];
	totalTokens: number;
	durationMs: number;
	updatedAt: number;
}

export class WorkflowManager extends EventEmitter {
	private runs = new Map<string, ManagedRun>();
	private journalDir?: string;
	private transcriptWatchers = new Map<string, () => void>();

	constructor(journalDir?: string) {
		super();
		this.journalDir = journalDir;
	}

	setJournalDir(dir: string): void {
		this.journalDir = dir;
	}

	getJournalDir(): string | undefined {
		return this.journalDir;
	}

	registerRun(
		runId: string,
		meta: WorkflowMeta,
		abortController?: AbortController,
		source?: { script?: string; cwd?: string },
	): ManagedRun {
		const run: ManagedRun = {
			runId,
			status: "running",
			snapshot: {
				meta,
				status: "running",
				phases: (meta.phases || []).map((p, idx) => ({
					title: p.title,
					index: idx,
					status: "pending",
					agents: [],
				})),
				agents: [],
				totalAgents: 0,
				totalTokens: 0,
				durationMs: 0,
				logs: [],
			},
			startedAt: Date.now(),
			updatedAt: Date.now(),
			journalDir: this.journalDir,
			abortController,
			script: source?.script,
			cwd: source?.cwd,
		};

		this.runs.set(runId, run);
		this.emit("agentStart", { runId });
		return run;
	}

	/**
	 * Get the raw script + cwd a run executed with, if this process still has
	 * it in memory (see ManagedRun.script). Returns undefined for runs that
	 * only exist as persisted journal entries (script text isn't journaled,
	 * only a hash — see journal-types.ts).
	 */
	getRunSource(runId: string): { script: string; cwd: string } | undefined {
		const run = this.runs.get(runId);
		if (!run?.script || !run.cwd) return undefined;
		return { script: run.script, cwd: run.cwd };
	}

	getRun(runId: string): ManagedRun | undefined {
		return this.runs.get(runId);
	}

	updateSnapshot(runId: string, updater: (snapshot: WorkflowSnapshot) => void): void {
		const run = this.runs.get(runId);
		if (!run) return;
		updater(run.snapshot);
		run.updatedAt = Date.now();
		this.emit("agentStart", { runId });
	}

	markAgentStart(runId: string, phaseIndex: number, agent: WorkflowAgentSnapshot): void {
		const run = this.runs.get(runId);
		if (!run) return;

		if (!agent.phase && run.snapshot.phases[phaseIndex]) {
			agent.phase = run.snapshot.phases[phaseIndex].title;
		}

		run.snapshot.agents.push(agent);
		run.snapshot.totalAgents++;
		if (run.snapshot.phases[phaseIndex]) {
			run.snapshot.phases[phaseIndex].agents.push(agent);
			if (run.snapshot.phases[phaseIndex].status === "pending") {
				run.snapshot.phases[phaseIndex].status = "active";
			}
		}
		run.updatedAt = Date.now();
		this.emit("agentStart", { runId, agentId: agent.id });

		if (agent.transcriptPath) {
			this.watchTranscript(runId, agent.id, agent.transcriptPath);
		}
	}

	markAgentEnd(runId: string, agentId: number, status: "done" | "error" | "skipped", result?: unknown, error?: string, tokens?: number, durationMs?: number): void {
		const key = `${runId}:${agentId}`;
		const stopWatcher = this.transcriptWatchers.get(key);
		if (stopWatcher) {
			stopWatcher();
			this.transcriptWatchers.delete(key);
		}

		const run = this.runs.get(runId);
		if (!run) return;

		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (agent) {
			agent.status = status;
			if (result !== undefined) {
				agent.result = result;
				agent.resultPreview = preview(result);
			}
			if (error !== undefined) agent.error = error;
			if (tokens !== undefined) {
				agent.outputTokens = tokens;
				run.snapshot.totalTokens += tokens;
			}
			if (durationMs !== undefined) agent.durationMs = durationMs;
		}

		run.updatedAt = Date.now();
		this.emit("agentEnd", { runId, agentId, status });
	}

	recordAgentHistory(runId: string, agentId: number, entry: AgentHistoryEntry): void {
		const run = this.runs.get(runId);
		if (!run) return;

		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (agent) {
			if (!agent.history) agent.history = [];
			agent.history.push(entry);
			run.updatedAt = Date.now();
			this.emit("agentHistory", { runId, agentId, history: agent.history });
		}
	}

	private watchTranscript(runId: string, agentId: number, transcriptPath: string): void {
		const key = `${runId}:${agentId}`;
		if (this.transcriptWatchers.has(key)) return;

		let byteOffset = 0;
		let lineBuffer = "";
		let stopped = false;

		const readNewLines = () => {
			if (stopped) return;
			try {
				if (!fs.existsSync(transcriptPath)) return;
				const stat = fs.statSync(transcriptPath);
				if (stat.size <= byteOffset) return;

				const fd = fs.openSync(transcriptPath, "r");
				const length = stat.size - byteOffset;
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, byteOffset);
				fs.closeSync(fd);

				byteOffset = stat.size;
				const content = lineBuffer + buffer.toString("utf-8");
				const lines = content.split("\n");
				lineBuffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const rec = JSON.parse(line);
						if (rec.recordType === "tool_start" && rec.toolName) {
							const argsPreview = rec.argsPreview || "";
							this.recordAgentHistory(runId, agentId, {
								role: "assistant",
								kind: "toolCall",
								toolName: rec.toolName,
								args: argsPreview,
								text: argsPreview ? `${rec.toolName}(${argsPreview})` : rec.toolName,
								timestamp: rec.ts,
							});
						} else if (rec.recordType === "message" && rec.role === "assistant" && typeof rec.text === "string" && rec.text.trim()) {
							this.recordAgentHistory(runId, agentId, {
								role: "assistant",
								kind: "text",
								text: rec.text,
								timestamp: rec.ts,
							});
						} else if (rec.recordType === "message" && rec.role === "toolResult") {
							this.recordAgentHistory(runId, agentId, {
								role: "toolResult",
								toolName: rec.toolName || "tool",
								text: rec.text || "(no output)",
								isError: rec.isError,
								timestamp: rec.ts,
							});
						}
					} catch {
						// Invalid JSON line, skip
					}
				}
			} catch {
				// Best-effort file read
			}
		};

		// Poll every 200ms
		const timer = setInterval(readNewLines, 200);
		timer.unref?.();

		// Also watch for immediate filesystem change events if supported
		let watcher: fs.FSWatcher | undefined;
		try {
			watcher = fs.watch(path.dirname(transcriptPath), (eventType, filename) => {
				if (filename && transcriptPath.endsWith(filename)) {
					readNewLines();
				}
			});
		} catch {
			// Watcher fallback to polling only
		}

		const stop = () => {
			clearInterval(timer);
			try {
				watcher?.close();
			} catch {
				// Ignore close error
			}
			// Final flush MUST run before `stopped` is set — readNewLines() bails
			// out immediately when `stopped` is true, so setting the flag first
			// would silently turn this into a no-op and drop any transcript lines
			// written in the last poll window (e.g. an agent's final assistant
			// message arriving right as markAgentEnd() fires).
			readNewLines();
			stopped = true;
		};

		this.transcriptWatchers.set(key, stop);
		readNewLines(); // Initial read
	}

	markPhase(runId: string, phaseIndex: number, title?: string): void {
		const run = this.runs.get(runId);
		if (!run) return;

		if (run.snapshot.phases[phaseIndex]) {
			run.snapshot.phases[phaseIndex].status = "active";
			if (title) run.snapshot.phases[phaseIndex].title = title;
		}

		run.updatedAt = Date.now();
		this.emit("phase", { runId, phaseIndex });
	}

	log(runId: string, message: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.snapshot.logs.push(message);
		run.updatedAt = Date.now();
		this.emit("log", { runId, message });
	}

	completeRun(runId: string, result?: unknown, error?: string): void {
		const run = this.runs.get(runId);
		if (!run) return;

		run.status = error ? "error" : "completed";
		run.snapshot.status = error ? "error" : "completed";
		run.snapshot.durationMs = Date.now() - run.startedAt;
		if (error) run.snapshot.error = error;
		else run.snapshot.result = result;

		for (const phase of run.snapshot.phases) {
			if (phase.status !== "pending") phase.status = "completed";
		}

		run.updatedAt = Date.now();
		this.emit(error ? "error" : "complete", { runId, result, error });
	}

	stopRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.status !== "running") return false;

		run.status = "stopped";
		run.snapshot.status = "cancelled";
		if (run.abortController) {
			run.abortController.abort();
		}
		run.updatedAt = Date.now();
		this.emit("stopped", { runId });
		return true;
	}

	pauseRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.status !== "running") return false;

		run.status = "paused";
		run.updatedAt = Date.now();
		this.emit("paused", { runId });
		return true;
	}

	resumeRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.status !== "paused") return false;

		run.status = "running";
		run.updatedAt = Date.now();
		this.emit("resumed", { runId });
		return true;
	}

	listActiveRuns(): ManagedRun[] {
		return Array.from(this.runs.values());
	}

	listRuns(): PersistedRun[] {
		const activeList: PersistedRun[] = Array.from(this.runs.values()).map((r) => ({
			runId: r.runId,
			workflowName: r.snapshot.meta.name || "unnamed",
			status: r.status,
			agents: r.snapshot.agents,
			totalTokens: r.snapshot.totalTokens,
			durationMs: r.snapshot.durationMs || Date.now() - r.startedAt,
			updatedAt: r.updatedAt,
		}));

		if (!this.journalDir || !fs.existsSync(this.journalDir)) {
			return activeList;
		}

		// Read historical run files from journalDir
		try {
			const files = fs.readdirSync(this.journalDir).filter((f) => f.endsWith(".jsonl"));
			const activeIds = new Set(activeList.map((r) => r.runId));

			for (const file of files) {
				const runId = file.slice(0, -6);
				if (activeIds.has(runId)) continue;

				const filePath = path.join(this.journalDir, file);
				const run = parsePersistedJournal(filePath, runId);
				if (run) activeList.push(run);
			}
		} catch {
			// ignore directory read errors
		}

		return activeList.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

function parsePersistedJournal(filePath: string, runId: string): PersistedRun | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length === 0) return undefined;

		let workflowName = "workflow";
		let status: RunStatus = "completed";
		const agents: WorkflowAgentSnapshot[] = [];
		let totalTokens = 0;

		for (const line of lines) {
			const rec = JSON.parse(line);
			if (rec.type === "run") {
				workflowName = rec.name || workflowName;
			} else if (rec.type === "agent") {
				agents.push({
					id: rec.seq || agents.length + 1,
					label: rec.label || "agent",
					prompt: rec.prompt || "",
					status: "done",
					resultPreview: preview(rec.result),
					outputTokens: rec.outputTokens || 0,
					durationMs: rec.durationMs || 0,
				});
				totalTokens += rec.outputTokens || 0;
			} else if (rec.type === "error") {
				agents.push({
					id: rec.seq || agents.length + 1,
					label: rec.label || "agent",
					prompt: "",
					status: "error",
					error: rec.error,
					durationMs: rec.durationMs || 0,
				});
				status = "error";
			} else if (rec.type === "result") {
				if (!rec.ok) status = "error";
			}
		}

		const stats = fs.statSync(filePath);
		return {
			runId,
			workflowName,
			status,
			agents,
			totalTokens,
			durationMs: 0,
			updatedAt: stats.mtimeMs,
		};
	} catch {
		return undefined;
	}
}

function preview(val: unknown, maxLen = 60): string {
	if (val === undefined || val === null) return "";
	const str = typeof val === "string" ? val : JSON.stringify(val);
	return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}
