/**
 * Workflow run journal: JSONL-based persistence for workflow execution.
 *
 * A journal logs every agent() call result to a JSONL file so workflows can be:
 * 1. Resumed after interruption without re-running cached agents
 * 2. Re-run with edited scripts where only new/changed calls execute
 *
 * Cache matching is based on (prompt + options) hash. If the script hash changes
 * (script was edited), the cache is invalidated and the run starts fresh.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalRunMeta, JournalAgentRecord, JournalResultRecord, JournalRecord } from "./journal-types.ts";

/**
 * Stable, dependency-free string hash (djb2-xor variant).
 * Used to hash script content and (prompt, options) pairs.
 */
export function hashString(input: string): string {
	let h = 5381;
	for (let i = 0; i < input.length; i++) {
		h = ((h << 5) + h) ^ input.charCodeAt(i);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Create a cache key for an agent() call based on prompt and options.
 * Used to detect if this exact call was run before (for resume).
 */
export function agentCallKey(prompt: string, opts: unknown): string {
	const optStr = JSON.stringify(opts || {});
	return hashString(`prompt:${prompt}|opts:${optStr}`);
}

/**
 * Persistent workflow run journal stored as JSONL.
 * Supports creating new runs and resuming existing runs with cache validation.
 */
export class RunJournal {
	readonly filePath: string;
	readonly runId: string;
	private seq = 0;
	private priorResults = new Map<string, { result: unknown; outputTokens: number }>();
	private totalTokens = 0;
	private agentCount = 0;

	private constructor(filePath: string, runId: string) {
		this.filePath = filePath;
		this.runId = runId;
	}

	/**
	 * Create a new workflow run journal.
	 * @param journalDir Directory to store the JSONL file
	 * @param scriptHash Hash of the workflow script (for cache invalidation)
	 * @param name Workflow name
	 * @param description Optional workflow description
	 * @returns A new RunJournal instance
	 */
	static create(journalDir: string, scriptHash: string, name: string, description?: string): RunJournal {
		const runId = randomUUID();
		fs.mkdirSync(journalDir, { recursive: true });

		const filePath = path.join(journalDir, `${runId}.jsonl`);
		fs.writeFileSync(filePath, ""); // Truncate if exists

		const journal = new RunJournal(filePath, runId);
		journal.append({
			type: "run",
			runId,
			scriptHash,
			name,
			description,
			startedAt: Date.now(),
		} as JournalRunMeta);

		return journal;
	}

	/**
	 * Resume a workflow run from a prior JSONL file.
	 * If the script hash matches, prior agent() results are cached.
	 * If the script hash differs (script was edited), returns a fresh journal.
	 *
	 * @param journalDir Directory containing JSONL files
	 * @param runId ID of the run to resume
	 * @param scriptHash Hash of the current script
	 * @param name Workflow name
	 * @param description Optional workflow description
	 * @returns { journal, isCacheValid, priorAgentCount }
	 */
	static resume(journalDir: string, runId: string, scriptHash: string, name: string, description?: string): {
		journal: RunJournal;
		isCacheValid: boolean;
		priorAgentCount: number;
	} {
		fs.mkdirSync(journalDir, { recursive: true });
		const filePath = path.join(journalDir, `${runId}.jsonl`);

		// File doesn't exist, create fresh run
		if (!fs.existsSync(filePath)) {
			const journal = RunJournal.create(journalDir, scriptHash, name, description);
			return { journal, isCacheValid: false, priorAgentCount: 0 };
		}

		// Load prior run and check script hash
		const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		if (lines.length === 0) {
			const journal = RunJournal.create(journalDir, scriptHash, name, description);
			return { journal, isCacheValid: false, priorAgentCount: 0 };
		}

		const firstRecord = JSON.parse(lines[0]) as JournalRecord;
		const priorScriptHash = firstRecord.type === "run" ? firstRecord.scriptHash : undefined;

		// Script was edited, invalidate cache and start fresh
		if (priorScriptHash !== scriptHash) {
			fs.writeFileSync(filePath, "");
			const journal = new RunJournal(filePath, runId);
			journal.append({
				type: "run",
				runId,
				scriptHash,
				name,
				description,
				startedAt: Date.now(),
			} as JournalRunMeta);
			return { journal, isCacheValid: false, priorAgentCount: 0 };
		}

		// Script hash matched, load prior agent results into cache
		const journal = new RunJournal(filePath, runId);
		let priorAgentCount = 0;

		for (let i = 1; i < lines.length; i++) {
			const record = JSON.parse(lines[i]) as JournalRecord;
			if (record.type === "agent") {
				const agentRecord = record as JournalAgentRecord;
				if (agentRecord.result !== undefined && !agentRecord.error) {
					journal.priorResults.set(agentRecord.key, {
						result: agentRecord.result,
						outputTokens: agentRecord.outputTokens || 0,
					});
					priorAgentCount++;
				}
				journal.seq = Math.max(journal.seq, agentRecord.seq + 1);
				journal.totalTokens += agentRecord.outputTokens || 0;
				journal.agentCount++;
			}
		}

		return { journal, isCacheValid: true, priorAgentCount };
	}

	/**
	 * Record a successful agent execution to the journal.
	 */
	recordAgent(
		key: string,
		label: string,
		result: unknown,
		outputTokens: number = 0,
		durationMs: number = 0,
	): void {
		this.seq++;
		this.agentCount++;
		this.totalTokens += outputTokens;

		// Cache the result for resume (new calls)
		if (!this.priorResults.has(key)) {
			this.priorResults.set(key, { result, outputTokens });
		}

		this.append({
			type: "agent",
			seq: this.seq,
			key,
			label,
			result,
			outputTokens,
			durationMs,
			startedAt: Date.now() - durationMs,
		} as JournalAgentRecord);
	}

	/**
	 * Record a failed agent execution.
	 */
	recordError(key: string, label: string, error: string, durationMs: number = 0): void {
		this.seq++;

		this.append({
			type: "agent",
			seq: this.seq,
			key,
			label,
			error,
			durationMs,
			startedAt: Date.now() - durationMs,
		} as JournalAgentRecord);
	}

	/**
	 * Record the final workflow result.
	 */
	recordResult(ok: boolean, result: unknown, error?: string, durationMs: number = 0): void {
		this.append({
			type: "result",
			ok,
			result,
			error,
			agentCount: this.agentCount,
			totalTokens: this.totalTokens,
			durationMs,
		} as JournalResultRecord);
	}

	/**
	 * Check if a prior agent result is cached (for resume).
	 * @param key Hash of (prompt + options)
	 * @returns Cached result and token count, or null if not cached
	 */
	getCachedResult(key: string): { result: unknown; outputTokens: number } | null {
		return this.priorResults.get(key) || null;
	}

	/**
	 * Get cumulative statistics for this run.
	 */
	getStats(): {
		runId: string;
		seq: number;
		agentCount: number;
		totalTokens: number;
	} {
		return {
			runId: this.runId,
			seq: this.seq,
			agentCount: this.agentCount,
			totalTokens: this.totalTokens,
		};
	}

	/**
	 * Append a record to the JSONL file (internal use).
	 */
	private append(record: JournalRecord): void {
		const line = JSON.stringify(record);
		fs.appendFileSync(this.filePath, line + "\n");
	}
}
