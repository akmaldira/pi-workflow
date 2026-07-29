/**
 * Workflow runner with journaling support.
 * Wraps runWorkflow to add JSONL-based run persistence and resume capability.
 */

import type { WorkflowRunOptions, WorkflowRunResult } from "./workflow.ts";
import { runWorkflow, parseWorkflowScript } from "./workflow.ts";
import { RunJournal, hashString, agentCallKey } from "./journal.ts";

export interface WorkflowRunnerOptions extends WorkflowRunOptions {
	/** Directory to store JSONL run journals */
	journalDir?: string;
	/** Run ID to resume (will check script hash for cache validity) */
	resumeRunId?: string;
}

/**
 * Run a workflow with optional journaling and resume capability.
 * @param script The workflow script
 * @param options Run options including journal settings
 * @returns Workflow result
 */
export async function runWorkflowWithJournal<T = unknown>(
	script: string,
	options: WorkflowRunnerOptions = {},
): Promise<WorkflowRunResult<T>> {
	const { meta: parsedMeta } = parseWorkflowScript(script);
	const scriptHash = hashString(script);

	// Initialize or resume journal
	let journal: RunJournal | undefined;
	let priorAgentCount = 0;

	if (options.journalDir) {
		if (options.resumeRunId) {
			const resumed = RunJournal.resume(
				options.journalDir,
				options.resumeRunId,
				scriptHash,
				parsedMeta.name,
				parsedMeta.description,
			);
			journal = resumed.journal;
			priorAgentCount = resumed.priorAgentCount;

			if (resumed.isCacheValid && priorAgentCount > 0) {
				options.onLog?.(`[journal] Resumed: ${priorAgentCount} agent(s) cached from prior run`);
			} else if (!resumed.isCacheValid) {
				options.onLog?.(`[journal] Script changed: cache invalidated, re-running all agents`);
			}
		} else {
			journal = RunJournal.create(
				options.journalDir,
				scriptHash,
				parsedMeta.name,
				parsedMeta.description,
			);
		}
	}

	// Store original onAgentEnd callback
	const originalOnAgentEnd = options.onAgentEnd;

	// Wrap to journal agent results
	if (journal) {
		options.onAgentEnd = (event) => {
			// Calculate cache key from prompt
			const cacheKey = agentCallKey(event.prompt, {});
			if (event.result !== null) {
				const tokens = extractTokensFromResult(event.result);
				journal.recordAgent(cacheKey, event.label, event.result, tokens, 0);
			} else {
				journal.recordError(cacheKey, event.label, "Agent failed", 0);
			}
			originalOnAgentEnd?.(event);
		};
	}

	const startTime = Date.now();
	let result: WorkflowRunResult<T>;
	let error: Error | undefined;

	try {
		result = await runWorkflow<T>(script, {
			...options,
			journal, // Pass journal to runWorkflow
		});
	} catch (e) {
		error = e as Error;
		result = {
			meta: parsedMeta,
			result: undefined as any,
			logs: options.onLog ? ["Error: " + String(error)] : [],
			phases: [],
			agentCount: 0,
			durationMs: Date.now() - startTime,
		};
	}

	// Record final result to journal
	if (journal) {
		const duration = Date.now() - startTime;
		journal.recordResult(!error, result.result, error?.message, duration);
		options.onLog?.(
			`[journal] Workflow saved to ${journal.filePath} (${journal.getStats().agentCount} agents, ${journal.getStats().totalTokens} tokens)`,
		);
	}

	if (error) throw error;
	return result;
}

/**
 * Extract token count from a workflow result (JSON string or object).
 */
function extractTokensFromResult(result: unknown): number {
	try {
		let obj: any;
		if (typeof result === "string") {
			obj = JSON.parse(result);
		} else {
			obj = result;
		}

		// Try common token count fields
		if (typeof obj?.usage?.output_tokens === "number") {
			return obj.usage.output_tokens;
		}
		if (typeof obj?.output_tokens === "number") {
			return obj.output_tokens;
		}
		if (typeof obj?.tokens === "number") {
			return obj.tokens;
		}

		// Fallback: estimate based on string length (rough ~4 chars per token)
		const text = typeof result === "string" ? result : JSON.stringify(result);
		return Math.ceil(text.length / 4);
	} catch {
		// Fallback estimate
		const text = typeof result === "string" ? result : JSON.stringify(result);
		return Math.ceil(text.length / 4);
	}
}
