/**
 * Journal types for workflow run persistence and resume capability.
 *
 * A workflow run is logged to a JSONL file with metadata, agent results, and timing info.
 * On resume, prior agent results are cached and skipped if the prompt & options haven't changed.
 */

/**
 * Metadata record for a workflow run (first line in JSONL).
 */
export interface JournalRunMeta {
	type: "run";
	runId: string;
	scriptHash: string; // djb2-xor hash of workflow script
	name: string;
	description?: string;
	startedAt: number;
}

/**
 * Agent execution record.
 */
export interface JournalAgentRecord {
	type: "agent";
	seq: number; // Sequential agent index in run
	key: string; // Hash of (prompt + options) for caching
	label: string; // Display label for this agent
	result?: unknown; // Agent output
	error?: string; // Error message if agent failed
	outputTokens?: number; // Output tokens estimated
	inputTokens?: number; // Input tokens estimated
	totalTokens?: number; // Total token usage
	durationMs: number; // Wall-clock time for agent execution
	startedAt: number; // Timestamp when agent started
}

/**
 * Final result record (last line in JSONL).
 */
export interface JournalResultRecord {
	type: "result";
	ok: boolean;
	result?: unknown; // Workflow final result
	error?: string; // Workflow error message
	agentCount: number; // Total agents spawned
	totalTokens: number; // Cumulative tokens used
	durationMs: number; // Total workflow duration
}

export type JournalRecord = JournalRunMeta | JournalAgentRecord | JournalResultRecord;

/**
 * Options for creating or resuming a journal.
 */
export interface JournalOptions {
	/** Directory containing workflow run journals */
	journalDir: string;
	/** Run ID to resume, or undefined to create a new run */
	resumeRunId?: string;
}

/**
 * Cache state for a resumed journal.
 */
export interface JournalResumeState {
	/** The journal instance (new or resumed) */
	journal: any; // RunJournal type
	/** True if script hash matched and cache is valid */
	isCacheValid: boolean;
	/** Number of prior cached agent results loaded */
	priorAgentCount: number;
}
