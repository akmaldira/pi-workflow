/**
 * Bridges graph runs into the display layer used by /workflows, the task
 * panel, and the workflow_status tool.
 *
 * The display model predates graphs: it thinks in terms of a run containing
 * numbered agents, optionally grouped into phases. A graph is a walk over
 * nodes, so the mapping is:
 *
 *   graph run       -> run
 *   node execution  -> agent entry (one per visit, so loops stay visible)
 *   node id         -> label
 *
 * Phases are left empty. A graph has no linear phase structure, and
 * inventing one would misrepresent a cyclic walk as a pipeline.
 */

import type { NodeExecution } from "./graph-executor.ts";
import type { GraphRunResult } from "./graph-executor.ts";
import type { WorkflowManager } from "./workflow-manager.ts";

export interface GraphDisplayOptions {
	manager: WorkflowManager;
	runId: string;
	name: string;
	/** Required: the display model treats it as non-optional metadata. */
	description: string;
	script?: string;
	cwd?: string;
	abortController?: AbortController;
}

/**
 * Strips reasoning blocks and markdown scaffolding from an agent's reply.
 *
 * Agent output regularly begins with `<think></think>` or a heading, which
 * would otherwise fill the preview with text that says nothing about what
 * the agent actually concluded.
 */
function cleanForPreview(text: string): string {
	return (
		text
			.replace(/<think>[\s\S]*?<\/think>/g, " ")
			.replace(/<\/?think>/g, " ")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/\*\*/g, "")
			.replace(/`/g, "")
			.replace(/\s+/g, " ")
			// Headings must also be stripped after whitespace collapsing: a
			// reply opening with "<think></think>## Answer" leaves the heading
			// mid-line, where the line-anchored pass above cannot see it.
			.replace(/(^|\s)#{1,6}\s+/g, "$1")
			.trim()
	);
}

function previewOf(value: unknown, limit = 60): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : String(value);
	const collapsed = cleanForPreview(text);
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Escalations are the reason this system exists, so a blocked result leads
 * with that fact rather than with whatever prose preceded it.
 */
function resultPreview(result: unknown): string {
	if (result && typeof result === "object") {
		const r = result as { status?: string; blockedOn?: string; reason?: string; answer?: string };
		if (r.status === "blocked") {
			const target = r.blockedOn ? ` on ${r.blockedOn}` : "";
			const why = r.reason ? `: ${previewOf(r.reason, 40)}` : "";
			return `blocked${target}${why}`;
		}
		if (r.answer !== undefined) return `answered "${previewOf(r.answer, 30)}"`;
	}
	return previewOf(result);
}

/**
 * Describes where a node's result went, for display.
 *
 * Routing is the interesting part of a graph run — it is what distinguishes
 * a coordination loop from a pipeline — so it belongs in the label rather
 * than being dropped.
 */
function routeSuffix(execution: NodeExecution): string {
	if (!execution.routedTo) return "";
	return `→ ${execution.routedTo}`;
}

/**
 * Reports graph progress to the display layer.
 *
 * Every method is defensive: display is an observer, and a rendering
 * problem must never take down a run that is otherwise working.
 */
export class GraphDisplayBridge {
	private readonly manager: WorkflowManager;
	private readonly runId: string;
	/** Display ids are 1-based and increment per visit, not per node. */
	private nextAgentId = 1;
	private readonly activeIds = new Map<number, number>();

	constructor(options: GraphDisplayOptions) {
		this.manager = options.manager;
		this.runId = options.runId;

		try {
			this.manager.registerRun(
				options.runId,
				{ name: options.name, description: options.description },
				options.abortController,
				options.script && options.cwd ? { script: options.script, cwd: options.cwd } : undefined,
			);
		} catch {
			// A run that cannot be displayed still needs to execute.
		}
	}

	nodeStarted(info: { step: number; nodeId: string; nodeType: string; agentName?: string }): void {
		const id = this.nextAgentId++;
		this.activeIds.set(info.step, id);

		const label = info.agentName ? `${info.nodeId} (${info.agentName})` : info.nodeId;

		try {
			this.manager.markAgentStart(this.runId, 0, {
				id,
				label,
				prompt: `${info.nodeType} node "${info.nodeId}"`,
				status: "running",
			});
		} catch {
			// Ignore display failures.
		}
	}

	nodeCompleted(execution: NodeExecution): void {
		const id = this.activeIds.get(execution.step) ?? this.nextAgentId++;
		this.activeIds.delete(execution.step);

		const status = execution.status === "failed" ? "error" : "done";
		// Routing goes first: it is what distinguishes a coordination loop from
		// a pipeline, and putting it last meant long agent prose truncated it
		// away exactly when the run was most interesting.
		const route = routeSuffix(execution).trim();
		const body = resultPreview(execution.result);
		const preview = route ? `${route}  ${body}` : body;

		try {
			this.manager.markAgentEnd(
				this.runId,
				id,
				status,
				preview,
				execution.error,
				execution.tokens,
				execution.durationMs,
			);
		} catch {
			// Ignore display failures.
		}
	}

	runCompleted(result: GraphRunResult): void {
		try {
			// The path is the single most useful line for a human scanning a
			// finished run: it shows which agents ran and where work looped.
			this.manager.log(this.runId, `Path: ${result.path.join(" → ")}`);
			this.manager.completeRun(this.runId, result.finalResult, result.error);
		} catch {
			// Ignore display failures.
		}
	}

	log(message: string): void {
		try {
			this.manager.log(this.runId, message);
		} catch {
			// Ignore display failures.
		}
	}
}
