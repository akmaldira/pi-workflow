/**
 * Workflow Tool - Execute dynamic JavaScript workflows that orchestrate subagents
 *
 * Based on py-dynamic-workflows (Claude-Code-style dynamic workflows).
 * The workflow script runs in a deterministic VM sandbox with agent(), parallel(),
 * pipeline(), phase(), and log() globals. The agent() global resolves named
 * agents from pi-subagents discovery and applies their frontmatter attributes.
 */

import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as path from "node:path";
import { parseWorkflowScript, runWorkflow, type WorkflowAgentRunner, type WorkflowRunResult } from "./workflow.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import type { WorkflowManager } from "./workflow-manager.ts";
import { getArtifactPaths } from "./artifacts.ts";
import type { ForkContextOptions } from "./types.ts";
import { TechnicalFailureError } from "./failure-classifier.ts";
import { saveWorkflowScript, loadSavedWorkflowScript, listSavedWorkflows } from "./workflow-library.ts";

const workflowToolSchema = Type.Object({
	script: Type.Optional(Type.String({
		description: [
			"Raw JavaScript workflow script, with no Markdown fences. Required unless loadWorkflow is provided.",
			"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
			"Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
			"parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
		].join(" "),
	})),
	args: Type.Optional(
		Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
	),
	agentScope: Type.Optional(
		Type.String({
			description: 'Which agent directories to use. Default: "both".',
			default: "both",
		}),
	),
	maxAgents: Type.Optional(
		Type.Number({ description: "Max number of agents to spawn in this workflow. Default: unlimited." }),
	),
	tokenBudget: Type.Optional(
		Type.Number({ description: "Token budget for this workflow. Warnings at 80% and 100%. Default: unlimited." }),
	),
	scriptTimeoutMs: Type.Optional(
		Type.Number({ description: "Script execution timeout in milliseconds. Default: unlimited." }),
	),
	journalDir: Type.Optional(
		Type.String({ description: "Directory to store JSONL run journals for persistence and resume. If not provided, journaling is disabled." }),
	),
	resumeRunId: Type.Optional(
		Type.String({ description: "Run ID to resume from a prior journal. Script must match (validated by hash) or cache is invalidated." }),
	),
	loadWorkflow: Type.Optional(
		Type.String({
			description:
				"Name of a previously saved workflow to run instead of writing `script` from scratch. Looks up .pi-workflow/workflows/<name>.js. " +
				"When set, `script` is optional and ignored if both are provided. Use the workflow_status tool or /workflows to discover saved workflow names, or check whether a matching workflow already exists before writing a new script.",
		}),
	),
	saveWorkflow: Type.Optional(
		Type.Boolean({
			description:
				"If true, persist this script to .pi-workflow/workflows/<meta.name>.js after a successful run so it can be reused later via loadWorkflow, without re-authoring it. Default: false.",
		}),
	),
});

export type WorkflowToolInput = {
	script?: string;
	args?: unknown;
	agentScope?: string;
	maxAgents?: number;
	tokenBudget?: number;
	scriptTimeoutMs?: number;
	journalDir?: string;
	resumeRunId?: string;
	loadWorkflow?: string;
	saveWorkflow?: boolean;
};

export interface WorkflowToolOptions {
	cwd?: string;
	concurrency?: number;
	maxConcurrent?: number;
	maxAgents?: number;
	tokenBudget?: number;
	scriptTimeoutMs?: number;
	journalDir?: string;
}

/**
 * Create a workflow agent runner that resolves named agents from pi-subagents
 * discovery and spawns them via the CLI (reusing the existing subagent tool logic).
 */
function createWorkflowAgentRunner(
	defaultCwd: string,
	agentScope: AgentScope,
	runSingleAgent: (
		cwd: string,
		agent: AgentConfig,
		task: string,
		options: {
			signal?: AbortSignal;
			parentSessionId?: string;
			onEvent?: (event: Record<string, unknown>) => void;
			runId?: string;
			index?: number;
			context?: "fresh" | "fork";
			forkContext?: ForkContextOptions;
			label?: string;
		},
	) => Promise<string>,
	parentSessionId?: string,
	onEvent?: (event: Record<string, unknown>) => void,
	runId?: string,
	forkContext?: ForkContextOptions,
): WorkflowAgentRunner {
	let childIndex = 0;
	return {
		async resolveAgent(agentName: string | undefined, cwd?: string): Promise<AgentConfig> {
			const discovery = discoverAgents(cwd ?? defaultCwd, agentScope);
			if (agentName) {
				const agent = discovery.agents.find((a) => a.name === agentName);
				if (agent) return agent;
			}
			return {
				name: agentName ?? "default",
				description: "Default workflow subagent",
				systemPrompt: "",
				source: "user",
				filePath: "",
			};
		},
		async run(
			prompt: string,
			agentConfig: AgentConfig,
			options: { label?: string; signal?: AbortSignal; cwd?: string; modelOverride?: string; context?: "fresh" | "fork" },
		): Promise<string> {
			childIndex++;
			const effectiveConfig = options.modelOverride
				? { ...agentConfig, name: options.label || agentConfig.name, model: options.modelOverride }
				: { ...agentConfig, name: options.label || agentConfig.name };
			return runSingleAgent(options.cwd ?? defaultCwd, effectiveConfig, prompt, {
				runId,
				index: childIndex,
				signal: options.signal,
				parentSessionId,
				onEvent,
				context: options.context,
				forkContext,
				label: options.label,
			});
		},
	};
}

/**
 * Render workflow progress as compact text for tool updates.
 */
interface WorkflowSnapshot {
	name: string;
	description?: string;
	phases: string[];
	currentPhase?: string;
	logs: string[];
	agents: Array<{
		id: number;
		label: string;
		phase?: string;
		prompt: string;
		status: "queued" | "running" | "done" | "error" | "skipped";
		resultPreview?: string;
		error?: string;
	}>;
	agentCount: number;
	runningCount: number;
	doneCount: number;
	errorCount: number;
	durationMs?: number;
	result?: unknown;
}

function createWorkflowSnapshot(meta: { name: string; description?: string }): WorkflowSnapshot {
	return {
		name: meta.name,
		description: meta.description,
		phases: [],
		logs: [],
		agents: [],
		agentCount: 0,
		runningCount: 0,
		doneCount: 0,
		errorCount: 0,
	};
}

function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	const runningCount = snapshot.agents.filter((a) => a.status === "running").length;
	const doneCount = snapshot.agents.filter((a) => a.status === "done").length;
	const errorCount = snapshot.agents.filter((a) => a.status === "error").length;
	return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

function statusIcon(status: string): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "skipped":
			return "-";
		default:
			return "?";
	}
}

function shorten(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function preview(value: unknown, max = 80): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false, options: { maxAgents?: number; maxLogs?: number; showResultPreviews?: boolean } = {}): string {
	const maxAgents = options.maxAgents ?? 4;
	const maxLogs = options.maxLogs ?? 1;
	const showResultPreviews = options.showResultPreviews ?? false;
	const state =
		snapshot.errorCount > 0
			? `, ${snapshot.errorCount} errors`
			: snapshot.runningCount > 0
				? `, ${snapshot.runningCount} running`
				: "";
	const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];

	const phaseNames = [...new Set([...snapshot.phases, ...(snapshot.currentPhase ? [snapshot.currentPhase] : []), ...snapshot.agents.map((a) => a.phase).filter(Boolean)])];
	const rendered = new Set<WorkflowSnapshot["agents"][number]>();

	for (const phase of phaseNames) {
		const agents = snapshot.agents.filter((a) => a.phase === phase);
		if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
		for (const agent of agents) rendered.add(agent);
		const done = agents.filter((a) => a.status === "done").length;
		const running = agents.filter((a) => a.status === "running").length;
		const errors = agents.filter((a) => a.status === "error").length;
		const skipped = agents.filter((a) => a.status === "skipped").length;
		const complete = agents.length > 0 && done + errors + skipped === agents.length;
		const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
		lines.push(
			`  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
		);

		const visibleAgents = agents.slice(-maxAgents);
		for (const agent of visibleAgents) {
			const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
			lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
		}
		if (agents.length > visibleAgents.length)
			lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
	}

	const unphased = snapshot.agents.filter((a) => !rendered.has(a));
	if (unphased.length) {
		lines.push("  Unphased");
		for (const agent of unphased.slice(-maxAgents)) {
			const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
			lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
		}
	}

	const visibleLogs = snapshot.logs.slice(-maxLogs);
	if (visibleLogs.length) {
		if (lines.length > 1) lines.push("");
		for (const log of visibleLogs) lines.push(`  log: ${log}`);
	}
	return `${completed ? "Workflow completed" : "Workflow running"}\n${lines.join("\n")}`;
}

export interface WorkflowToolOptionsFull extends WorkflowToolOptions {
	/** Optional WorkflowManager for registering and updating live runs. */
	workflowManager?: WorkflowManager;
	/**
	 * Function to run a single subagent. This is injected by the extension
	 * and reuses the existing CLI-based subagent spawning logic.
	 */
	runSingleAgent: (
		cwd: string,
		agent: AgentConfig,
		task: string,
		options: {
			signal?: AbortSignal;
			parentSessionId?: string;
			onEvent?: (event: Record<string, unknown>) => void;
			runId?: string;
			index?: number;
			context?: "fresh" | "fork";
			forkContext?: ForkContextOptions;
			label?: string;
		},
	) => Promise<string>;
}

export function createWorkflowTool(options: WorkflowToolOptionsFull): ToolDefinition<typeof workflowToolSchema, any> {
	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
			"Pass `script` (raw JS starting with export const meta = { name, description }) to run a new workflow, or `loadWorkflow: '<name>'` to re-run one previously saved with saveWorkflow: true, without resending the script.",
		].join(" "),
		promptSnippet:
			"Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups. Pass loadWorkflow: '<name>' to re-run a previously saved workflow instead of rewriting the script.",
		promptGuidelines: [
			"Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
			"For workflow, before writing a new script, consider whether a similar workflow was already saved (check with loadWorkflow, or ask the user, or use /workflows). If the user asks to reuse/repeat/run again a workflow they ran before, use loadWorkflow with its saved name instead of re-authoring the script.",
			"For workflow, when a script is likely to be reused (the user says things like 'save this workflow', 'do this again later', or the task is a repeatable process), pass saveWorkflow: true so it's persisted to .pi-workflow/workflows/<name>.js and can be re-run later via loadWorkflow.",
			"For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
			"For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
			"For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
			"For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
			"For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
			"For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
			"For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
			"For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
			"For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
			"For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
			"For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
			"For workflow, agent() can resolve named agents from ~/.pi/agent/agents/*.md by prefixing the prompt with the agent name: agent('researcher: Find security issues'). The agent's frontmatter attributes (model, tools, skills, system prompt, etc.) are applied automatically.",
			"For workflow, if agent() needs machine-readable output, use JSON.parse() on the result text or structure your prompt to return JSON. Do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
		],
		parameters: workflowToolSchema,
		prepareArguments(args) {
			return normalizeWorkflowToolArgs(args);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runCwd = options.cwd ?? ctx.cwd;
			let scriptSource = params.script;
			if (params.loadWorkflow) {
				const saved = loadSavedWorkflowScript(runCwd, params.loadWorkflow);
				if (!saved) {
					const available = listSavedWorkflows(runCwd).map((w) => w.name);
					const suggestion = available.length
						? `Available saved workflows: ${available.join(", ")}.`
						: "No workflows have been saved yet in this project (.pi-workflow/workflows/).";
					throw new Error(`No saved workflow named "${params.loadWorkflow}" found. ${suggestion}`);
				}
				scriptSource = saved;
			}
			if (!scriptSource) {
				throw new Error("workflow requires either `script` or `loadWorkflow`");
			}
			const script = normalizeWorkflowScript(scriptSource);
			const parsed = parseWorkflowScript(script);
			const agentScope: AgentScope = (params.agentScope as AgentScope) ?? "both";

			let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
			const displayOptions = { maxAgents: 4, maxLogs: 1, showResultPreviews: false };

			const workflowManager = options.workflowManager;
			const runId = params.resumeRunId || `wf-${Date.now()}`;
			// The WorkflowManager owns an AbortController for this run so the
			// /workflows TUI's "stop" action (and any programmatic abort, e.g. an
			// auto-abort on a technical subagent failure) can cancel the run.
			// effectiveSignal combines the tool-call's own signal (aborted if the
			// main agent cancels the tool call) with the manager's controller
			// (aborted by stopRun()/auto-abort) so runWorkflow() reacts to either.
			let effectiveSignal = signal;
			let runAbortController: AbortController | undefined;
			if (workflowManager) {
				if (params.journalDir) workflowManager.setJournalDir(params.journalDir);
				runAbortController = new AbortController();
				if (signal) {
					signal.addEventListener("abort", () => runAbortController?.abort());
				}
				workflowManager.registerRun(runId, parsed.meta, runAbortController, { script, cwd: runCwd });
				effectiveSignal = signal
					? AbortSignal.any([signal, runAbortController.signal])
					: runAbortController.signal;
			}

			const update = () => {
				snapshot = recomputeWorkflowSnapshot(snapshot);
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text" as const, text: renderWorkflowText(snapshot, false, displayOptions) }],
						details: snapshot,
					});
				}
			};

			const recordPhase = (title: string | undefined) => {
				if (!title) return;
				if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
			};

			// NOTE: agent history (tool calls, results, assistant text) is recorded
			// exclusively by WorkflowManager.watchTranscript(), which tails each
			// agent's transcript.jsonl file (see markAgentStart()). We intentionally
			// do NOT also record history here from the live onEvent stream — doing so
			// previously caused every tool call/result to be recorded twice (once
			// live, once from the transcript tail), producing garbled duplicate
			// entries in the /workflows history pager.

			const forkContext: ForkContextOptions | undefined = ctx.model
				? {
					sessionManager: ctx.sessionManager,
					modelRegistry: ctx.modelRegistry,
					fallbackModel: ctx.model,
				}
				: undefined;

			const agentRunner = createWorkflowAgentRunner(
				runCwd,
				agentScope,
				options.runSingleAgent,
				ctx.sessionManager.getSessionId(),
				undefined,
				runId,
				forkContext,
			);

			let technicalFailure: { agentLabel: string; failureCode: string; failureReason: string } | undefined;

			let result: WorkflowRunResult;
			try {
				result = await runWorkflow(script, {
					cwd: runCwd,
					args: params.args,
					signal: effectiveSignal,
					concurrency: options.concurrency,
					maxConcurrent: options.maxConcurrent,
					maxAgents: params.maxAgents,
					tokenBudget: params.tokenBudget,
					scriptTimeoutMs: params.scriptTimeoutMs,
					agentRunner,
					onTechnicalFailure(error) {
						// Abort the workflow run immediately: this SIGTERMs any
						// sibling subagents still in flight (via effectiveSignal,
						// which threads down to execution.ts's spawned child
						// processes) rather than letting them run to completion
						// after the failure is already known to be unrecoverable.
						const techError = error as TechnicalFailureError;
						technicalFailure = {
							agentLabel: techError.agentLabel,
							failureCode: techError.failureCode,
							failureReason: techError.failureReason,
						};
						runAbortController?.abort();
					},
					onLog(message) {
						snapshot.logs.push(message);
						if (workflowManager) workflowManager.log(runId, message);
						update();
					},
					onPhase(title) {
						snapshot.currentPhase = title;
						recordPhase(title);
						const phaseIdx = snapshot.phases.indexOf(title);
						if (workflowManager) workflowManager.markPhase(runId, Math.max(0, phaseIdx), title);
						update();
					},
					onAgentStart(event) {
						if (effectiveSignal?.aborted) throw new Error("Workflow was aborted");
						recordPhase(event.phase);
						const agentId = snapshot.agents.length + 1;
						const artifactsDir = path.join(runCwd, ".pi-workflow", "artifacts");
						const artifactPaths = getArtifactPaths(artifactsDir, runId, event.label, agentId);
						const agentSnapshot = {
							id: agentId,
							label: event.label,
							phase: event.phase,
							prompt: event.prompt,
							status: "running" as const,
							transcriptPath: artifactPaths.transcriptPath,
						};
						snapshot.agents.push(agentSnapshot);
						const phaseIdx = event.phase ? snapshot.phases.indexOf(event.phase) : 0;
						if (workflowManager) workflowManager.markAgentStart(runId, Math.max(0, phaseIdx), agentSnapshot);
						update();
					},
					onAgentEnd(event) {
						const agent = [...snapshot.agents]
							.reverse()
							.find((a) => a.label === event.label && a.status === "running");
						if (agent) {
							agent.status = event.result === null ? "error" : "done";
							// Store the full result alongside the truncated preview so the
							// /workflows pager's Result section can render the complete agent
							// output instead of only the first ~60 characters.
							agent.result = event.result;
							agent.resultPreview = preview(event.result);
							if (workflowManager) {
								workflowManager.markAgentEnd(runId, agent.id, agent.status === "error" ? "error" : "done", event.result);
							}
						}
						update();
					},
				});
			} catch (error) {
				console.error("[Workflow Error]", error);

				if (technicalFailure) {
					// A subagent hit a technical failure (LLM provider error, process
					// crash, protocol limit — see failure-classifier.ts). The workflow
					// was auto-aborted (sibling subagents SIGTERM'd via
					// runAbortController) rather than letting them keep running or
					// letting a dependent agent() call consume a corrupted result.
					// Mark any still-running agents as skipped/aborted-by-dependency
					// (distinct from the agent that actually failed, which already has
					// its own status/error from onAgentEnd/markAgentEnd).
					for (const a of snapshot.agents) {
						if (a.status === "running") {
							a.status = "skipped";
							a.error = "Workflow stopped: a sibling agent hit a technical failure";
						}
					}
					snapshot = recomputeWorkflowSnapshot(snapshot);
					const failureMessage =
						`Workflow "${parsed.meta.name}" stopped: agent "${technicalFailure.agentLabel}" hit a technical failure ` +
						`(${technicalFailure.failureCode}): ${technicalFailure.failureReason}\n\n` +
						`This was classified as a technical/infrastructure failure (not a normal agent-level error, e.g. failing tests), ` +
						`so the workflow was stopped and remaining subagents were cancelled to avoid wasting work on corrupted input.\n\n` +
						`Run ID: ${runId}. Use the workflow_status tool with this runId to inspect the failing agent's full result, error, and tool-call history before deciding how to proceed ` +
						`(e.g. retry, fix the workflow script, or wait and re-run if this looks like a transient provider outage).`;
					if (workflowManager) {
						workflowManager.completeRun(runId, undefined, failureMessage);
					}
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text" as const, text: renderWorkflowText(snapshot, true, displayOptions) }],
							details: snapshot,
						});
					}
					throw new Error(failureMessage);
				}

				if (workflowManager) {
					workflowManager.completeRun(runId, undefined, error instanceof Error ? error.message : String(error));
				}
				if (effectiveSignal?.aborted || isAbortError(error)) {
					for (const agent of snapshot.agents) {
						if (agent.status === "running") {
							agent.status = "skipped";
							agent.error = "aborted";
						}
					}
					snapshot = recomputeWorkflowSnapshot(snapshot);
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text" as const, text: renderWorkflowText(snapshot, true, displayOptions) }],
							details: snapshot,
						});
					}
					throw new Error("Workflow was aborted");
				}
				throw error;
			}

			if (result.agentCount === 0) {
				throw new Error(
					"workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
				);
			}

			snapshot.result = result.result;
			snapshot.durationMs = result.durationMs;
			snapshot = recomputeWorkflowSnapshot(snapshot);
			if (workflowManager) {
				workflowManager.completeRun(runId, result.result);
			}
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text" as const, text: renderWorkflowText(snapshot, true, displayOptions) }],
					details: snapshot,
				});
			}

			// Persist the script for reuse via loadWorkflow, but only after a
			// successful run (agentCount > 0 already validated above) — saving a
			// script that turned out broken/pointless would pollute the library.
			// Skip re-saving when this run itself came from loadWorkflow with no
			// edits (params.script undefined), since it's already on disk.
			let savedNote = "";
			if (params.saveWorkflow && params.script) {
				try {
					const saved = saveWorkflowScript(runCwd, script, result.meta);
					savedNote = `\n\nSaved for reuse: run again anytime with { loadWorkflow: "${saved.name}" } (no need to resend the script). Stored at ${path.relative(runCwd, saved.filePath)}.`;
				} catch (err) {
					savedNote = `\n\n(Note: failed to save workflow for reuse: ${err instanceof Error ? err.message : String(err)})`;
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}${savedNote}`,
					},
				],
				details: {
					...snapshot,
					meta: result.meta,
					phases: result.phases,
					logs: result.logs,
					result: result.result,
					durationMs: result.durationMs,
				},
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const snapshot = result.details as WorkflowSnapshot | undefined;
			if (snapshot?.name) {
				return new Text(renderWorkflowText(snapshot, !isPartial, { maxAgents: 4, maxLogs: 1, showResultPreviews: false }), 0, 0);
			}
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
		},
	});
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
	if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string, or a loadWorkflow name");
	const value = args as Record<string, unknown>;
	if (typeof value.loadWorkflow === "string" && value.loadWorkflow.trim()) {
		// script is optional/ignored when loading a saved workflow by name; the
		// actual script text is resolved from disk inside execute().
		return { ...value, script: typeof value.script === "string" ? normalizeWorkflowScript(value.script) : undefined } as WorkflowToolInput;
	}
	if (typeof value.script !== "string") throw new Error("workflow requires either `script` (a string) or `loadWorkflow` (a saved workflow name)");
	return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
	let text = script.trim();
	const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
	if (fence) text = fence[1].trim();
	return text;
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /\babort(?:ed)?\b/i.test(error.message);
}
