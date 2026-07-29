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
import { parseWorkflowScript, runWorkflow, type WorkflowAgentRunner, type WorkflowRunResult } from "./workflow.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const workflowToolSchema = Type.Object({
	script: Type.String({
		description: [
			"Required raw JavaScript workflow script, with no Markdown fences.",
			"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
			"Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
			"parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
		].join(" "),
	}),
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
});

export type WorkflowToolInput = {
	script: string;
	args?: unknown;
	agentScope?: string;
	maxAgents?: number;
	tokenBudget?: number;
	scriptTimeoutMs?: number;
	journalDir?: string;
	resumeRunId?: string;
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
		options: { signal?: AbortSignal; parentSessionId?: string },
	) => Promise<string>,
	parentSessionId?: string,
): WorkflowAgentRunner {
	return {
		async resolveAgent(agentName: string | undefined, cwd?: string): Promise<AgentConfig> {
			const discovery = discoverAgents(cwd ?? defaultCwd, agentScope);
			if (agentName) {
				const agent = discovery.agents.find((a) => a.name === agentName);
				if (agent) return agent;
				// Fall back to a default agent config
			}
			// Return a default agent config (no special attributes)
			return {
				name: agentName ?? "default",
				description: "Default workflow subagent",
				systemPrompt: "",
				source: "user",
				filePath: "",
			};
		},
		async run(prompt: string, agentConfig: AgentConfig, options: { label?: string; signal?: AbortSignal; cwd?: string; modelOverride?: string }): Promise<string> {
			// If model override is specified, create a modified agent config
			const effectiveConfig = options.modelOverride
				? { ...agentConfig, model: options.modelOverride }
				: agentConfig;
			return runSingleAgent(options.cwd ?? defaultCwd, effectiveConfig, prompt, { signal: options.signal, parentSessionId });
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
	/**
	 * Function to run a single subagent. This is injected by the extension
	 * and reuses the existing CLI-based subagent spawning logic.
	 */
	runSingleAgent: (
		cwd: string,
		agent: AgentConfig,
		task: string,
		options: { signal?: AbortSignal; parentSessionId?: string },
	) => Promise<string>;
}

export function createWorkflowTool(options: WorkflowToolOptionsFull): ToolDefinition<typeof workflowToolSchema, any> {
	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
			"script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
		].join(" "),
		promptSnippet:
			"Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
		promptGuidelines: [
			"Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
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
			const script = normalizeWorkflowScript(params.script);
			const parsed = parseWorkflowScript(script);
			const agentScope: AgentScope = (params.agentScope as AgentScope) ?? "both";

			let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
			const displayOptions = { maxAgents: 4, maxLogs: 1, showResultPreviews: false };

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

			const agentRunner = createWorkflowAgentRunner(
				options.cwd ?? ctx.cwd,
				agentScope,
				options.runSingleAgent,
				ctx.sessionManager.getSessionId(),
			);

			let result: WorkflowRunResult;
			try {
				result = await runWorkflow(script, {
					cwd: options.cwd ?? ctx.cwd,
					args: params.args,
					signal,
					concurrency: options.concurrency,
					maxConcurrent: options.maxConcurrent,
					maxAgents: params.maxAgents,
					tokenBudget: params.tokenBudget,
					scriptTimeoutMs: params.scriptTimeoutMs,
					agentRunner,
					onLog(message) {
						snapshot.logs.push(message);
						update();
					},
					onPhase(title) {
						snapshot.currentPhase = title;
						recordPhase(title);
						update();
					},
					onAgentStart(event) {
						if (signal?.aborted) throw new Error("Workflow was aborted");
						recordPhase(event.phase);
						snapshot.agents.push({
							id: snapshot.agents.length + 1,
							label: event.label,
							phase: event.phase,
							prompt: event.prompt,
							status: "running",
						});
						update();
					},
					onAgentEnd(event) {
						const agent = [...snapshot.agents]
							.reverse()
							.find((a) => a.label === event.label && a.status === "running");
						if (agent) {
							agent.status = event.result === null ? "error" : "done";
							agent.resultPreview = preview(event.result);
						}
						update();
					},
				});
			} catch (error) {
				console.error("[Workflow Error]", error);
				if (signal?.aborted || isAbortError(error)) {
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
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text" as const, text: renderWorkflowText(snapshot, true, displayOptions) }],
					details: snapshot,
				});
			}

			return {
				content: [
					{
						type: "text",
						text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
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
	if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
	const value = args as Record<string, unknown>;
	if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
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
