/**
 * Graph run journaling and resume.
 *
 * Each node execution is appended to a JSONL file as it completes. Because
 * a graph walk is an ordered sequence of node executions, resume is a
 * replay: re-apply each recorded result to state in order, then continue
 * from wherever the last recorded node routed.
 *
 * This is why graph resume is tractable where the imperative workflow's was
 * not. That design keyed the cache on a hash of (prompt + options), which
 * meant a prompt built from earlier results changed its own key whenever
 * anything upstream changed, and cache hits were both hard to predict and
 * hard to invalidate correctly. A graph has an explicit execution order and
 * stable node ids, so "what already ran" needs no heuristic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { NodeExecution } from "./graph-executor.ts";
import type { GraphState } from "./graph-dsl.ts";
import { rehydrateState } from "./graph-node-runner.ts";
import { hashString } from "./journal.ts";

export interface GraphJournalRunRecord {
	type: "graph_run";
	runId: string;
	/** Invalidates a resume when the script changed. */
	scriptHash: string;
	name: string;
	description?: string;
	entry: string;
	nodeIds: string[];
	initialState: GraphState;
	startedAt: number;
}

export interface GraphJournalNodeRecord {
	type: "node";
	/** 1-based execution order. A revisited node appears once per visit. */
	step: number;
	nodeId: string;
	nodeType: "agent" | "mainAgent" | "human";
	agentName?: string;
	status: "ok" | "failed" | "skipped";
	result: unknown;
	routedTo: string;
	tokens?: number;
	error?: string;
	startedAt: number;
	durationMs: number;
}

export interface GraphJournalResultRecord {
	type: "graph_result";
	status: "completed" | "aborted" | "max_iterations";
	iterations: number;
	totalTokens: number;
	durationMs: number;
	error?: string;
}

export type GraphJournalRecord =
	| GraphJournalRunRecord
	| GraphJournalNodeRecord
	| GraphJournalResultRecord;

export interface GraphResumeState {
	/** Node executions already recorded, in order. */
	executions: GraphJournalNodeRecord[];
	/** State rebuilt by replaying those executions over the initial state. */
	state: GraphState;
	/** Node to continue from, or null when the run already finished. */
	resumeFrom: string | null;
	/** Executions already done, so the iteration cap stays meaningful. */
	completedSteps: number;
	/** False when the script changed since the journal was written. */
	isValid: boolean;
	invalidReason?: string;
}

export function graphScriptHash(script: string): string {
	return hashString(script);
}

function journalPath(journalDir: string, runId: string): string {
	return path.join(journalDir, `${runId}.jsonl`);
}

/**
 * Append-only JSONL journal for one graph run.
 *
 * Writes are best-effort: journaling exists to make a run inspectable and
 * resumable, and losing that is strictly better than aborting a run that is
 * otherwise working. Write failures are surfaced via `writeErrors` so a
 * caller can report them without the run dying.
 */
export class GraphJournal {
	readonly filePath: string;
	readonly runId: string;
	readonly writeErrors: string[] = [];

	private totalTokens = 0;
	private nodeCount = 0;

	private constructor(filePath: string, runId: string) {
		this.filePath = filePath;
		this.runId = runId;
	}

	static create(options: {
		journalDir: string;
		runId: string;
		scriptHash: string;
		name: string;
		description?: string;
		entry: string;
		nodeIds: string[];
		initialState: GraphState;
	}): GraphJournal {
		const filePath = journalPath(options.journalDir, options.runId);
		const journal = new GraphJournal(filePath, options.runId);

		try {
			fs.mkdirSync(options.journalDir, { recursive: true });
		} catch (error) {
			journal.writeErrors.push(
				`Could not create journal directory: ${error instanceof Error ? error.message : String(error)}`,
			);
			return journal;
		}

		journal.append({
			type: "graph_run",
			runId: options.runId,
			scriptHash: options.scriptHash,
			name: options.name,
			description: options.description,
			entry: options.entry,
			nodeIds: options.nodeIds,
			initialState: options.initialState,
			startedAt: Date.now(),
		});

		return journal;
	}

	private append(record: GraphJournalRecord): void {
		try {
			fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
		} catch (error) {
			this.writeErrors.push(error instanceof Error ? error.message : String(error));
		}
	}

	recordNode(execution: NodeExecution): void {
		this.nodeCount += 1;
		this.totalTokens += execution.tokens ?? 0;

		this.append({
			type: "node",
			step: execution.step,
			nodeId: execution.nodeId,
			nodeType: execution.nodeType,
			agentName: execution.agentName,
			status: execution.status,
			result: execution.result,
			routedTo: execution.routedTo,
			tokens: execution.tokens,
			error: execution.error,
			startedAt: execution.startedAt,
			durationMs: execution.durationMs,
		});
	}

	recordResult(result: {
		status: "completed" | "aborted" | "max_iterations";
		iterations: number;
		durationMs: number;
		error?: string;
	}): void {
		this.append({
			type: "graph_result",
			status: result.status,
			iterations: result.iterations,
			totalTokens: this.totalTokens,
			durationMs: result.durationMs,
			error: result.error,
		});
	}

	get tokens(): number {
		return this.totalTokens;
	}

	get nodes(): number {
		return this.nodeCount;
	}
}

/** Reads a journal file, skipping unparseable lines. */
export function readGraphJournal(filePath: string): GraphJournalRecord[] {
	if (!fs.existsSync(filePath)) return [];

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const records: GraphJournalRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as GraphJournalRecord);
		} catch {
			// A partial final line is expected if the process died mid-write.
			// Everything before it is still usable.
		}
	}

	return records;
}

/**
 * Rebuilds the state and resume point for a previous run.
 *
 * Resume is refused when the script hash differs. A changed script may have
 * renamed nodes, rerouted edges, or altered prompts, so replaying old
 * results into it would produce a run that never actually happened.
 */
export function loadGraphResumeState(options: {
	journalDir: string;
	runId: string;
	scriptHash: string;
}): GraphResumeState {
	const empty: GraphResumeState = {
		executions: [],
		state: {},
		resumeFrom: null,
		completedSteps: 0,
		isValid: false,
	};

	const records = readGraphJournal(journalPath(options.journalDir, options.runId));
	if (records.length === 0) {
		return { ...empty, invalidReason: `No journal found for run "${options.runId}".` };
	}

	const meta = records.find((r): r is GraphJournalRunRecord => r.type === "graph_run");
	if (!meta) {
		return { ...empty, invalidReason: "Journal is missing its run header." };
	}

	if (meta.scriptHash !== options.scriptHash) {
		return {
			...empty,
			invalidReason:
				"The graph script changed since this run was journaled, so previous results cannot be reused. Start a new run.",
		};
	}

	const executions = records.filter((r): r is GraphJournalNodeRecord => r.type === "node");

	// Replay in recorded order. A revisited node overwrites its earlier
	// entry, exactly as it would during a live run.
	const state: GraphState = { ...meta.initialState };
	for (const execution of executions) {
		state[execution.nodeId] = execution.result;
	}

	// Results came back through JSON.parse, so they are plain objects that
	// have lost the toString() making `${state.architect}` render the agent's
	// text. Without this a resumed run silently interpolates "[object Object]"
	// into every prompt built from an earlier node.
	rehydrateState(state);

	const finished = records.find((r): r is GraphJournalResultRecord => r.type === "graph_result");
	const last = executions[executions.length - 1];

	let resumeFrom: string | null;
	if (finished?.status === "completed") {
		resumeFrom = null;
	} else if (!last) {
		resumeFrom = meta.entry;
	} else if (last.routedTo === "END" || last.routedTo === "") {
		// An empty routedTo means the node ran but routing failed or the run
		// aborted there, so that node is where work stopped.
		resumeFrom = last.routedTo === "END" ? null : last.nodeId;
	} else {
		resumeFrom = last.routedTo;
	}

	return {
		executions,
		state,
		resumeFrom,
		completedSteps: executions.length,
		isValid: true,
	};
}

/** Lists journaled graph runs, newest first. */
export function listGraphRuns(journalDir: string): {
	runId: string;
	name: string;
	startedAt: number;
	status?: string;
	iterations?: number;
	totalTokens?: number;
}[] {
	if (!fs.existsSync(journalDir)) return [];

	let entries: string[];
	try {
		entries = fs.readdirSync(journalDir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}

	const runs = [];
	for (const entry of entries) {
		const records = readGraphJournal(path.join(journalDir, entry));
		const meta = records.find((r): r is GraphJournalRunRecord => r.type === "graph_run");
		if (!meta) continue;

		const result = records.find((r): r is GraphJournalResultRecord => r.type === "graph_result");
		runs.push({
			runId: meta.runId,
			name: meta.name,
			startedAt: meta.startedAt,
			status: result?.status ?? "incomplete",
			iterations: result?.iterations,
			totalTokens: result?.totalTokens,
		});
	}

	return runs.sort((a, b) => b.startedAt - a.startedAt);
}
