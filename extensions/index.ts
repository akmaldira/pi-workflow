/**
 * pi-workflow - Subagent delegation + dynamic workflow orchestration
 *
 * Tools:
 * - subagent: Delegate tasks to named subagents (single + parallel modes)
 * - workflow: Execute dynamic JavaScript workflows that orchestrate subagents
 *
 * Commands:
 * - /agents: List available subagents
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { buildAgentCatalogGuideline, createListAgentsTool } from "./agent-catalog.ts";
import { createGraphWorkflowTool } from "./graph-tool.ts";
import { runSingleAgent } from "./execution.ts";
import type { SingleResult, ForkContextOptions, AgentHistoryEntry } from "./types.ts";
import { listSavedWorkflows, deleteSavedWorkflow } from "./workflow-library.ts";
import { getFinalOutput } from "./utils.ts";
import { TechnicalFailureError, type FailureClassification } from "./failure-classifier.ts";
import { WorkflowManager } from "./workflow-manager.ts";
import { openWorkflowNavigator } from "./workflow-ui.ts";
import { registerTaskPanel } from "./task-panel.ts";
import { registerWorkflowMode } from "./workflow-mode.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

interface SubagentDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	results: SingleResult[];
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.error || result.errorMessage || getFinalOutput(result.messages ?? []) || "(no output)";
	}
	return result.finalOutput || getFinalOutput(result.messages ?? []) || "(no output)";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath: path.relative(process.cwd(), filePath) };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

const ContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description:
		'Context mode: "fork" (default) injects a compaction-style structured summary (Goal/Progress/Key Decisions/etc) ' +
		'of the parent session, not the raw transcript, keeping cost bounded. "fresh" starts with no inherited history.',
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	context: Type.Optional(ContextModeSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both".',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	context: Type.Optional(ContextModeSchema),
});

/**
 * Run a single subagent and return just the output text.
 * Used by the workflow tool's agent() global.
 */
export async function runSubagentForWorkflow(
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
): Promise<string> {
	const runId = options.runId ?? `workflow-${Date.now()}`;
	const artifactsDir = path.join(cwd, ".pi-workflow", "artifacts");
	const result = await runSingleAgent(cwd, agent, task, {
		runId,
		index: options.index,
		signal: options.signal,
		parentSessionId: options.parentSessionId,
		onEvent: options.onEvent,
		context: options.context,
		forkContext: options.forkContext,
		artifactsDir,
		artifactConfig: {
			enabled: true,
			includeInput: true,
			includeOutput: true,
			includeJsonl: true,
			includeTranscript: true,
			includeMetadata: true,
			cleanupDays: 7,
		},
	});
	// A "technical" failure (LLM provider error, process crash, protocol
	// limit, etc. — see failure-classifier.ts) is not something the workflow
	// script should be allowed to silently swallow into a garbage/error-text
	// result: throw so agent() in workflow.ts halts the whole run instead of
	// letting a downstream agent() call consume corrupted input.
	if (result.failureClass === "technical") {
		throw new TechnicalFailureError(
			options.label || agent.name,
			{
				class: "technical",
				code: (result.failureCode as FailureClassification["code"]) ?? "provider-error",
				reason: result.failureReason || result.error || result.errorMessage || "Unknown technical failure",
			},
			runId,
		);
	}
	return getResultOutput(result);
}

const WorkflowStatusParams = Type.Object({
	runId: Type.String({ description: "The workflow run ID to inspect (e.g. as reported in a workflow's failure message or from /workflows)." }),
	agentId: Type.Optional(
		Type.Number({ description: "If provided, return full detail (prompt, result, error, tool-call/output history) for just this one agent. Otherwise returns a summary of all agents in the run." }),
	),
	historyLimit: Type.Optional(
		Type.Number({ description: "Max number of history entries to return per agent when agentId is provided (default 100; entries are chronological, so this trims from the end)." }),
	),
});

export function summarizeHistoryEntry(entry: AgentHistoryEntry): string {
	if (entry.role === "assistant" && entry.kind === "toolCall") {
		return `\u2192 ${entry.toolName}${entry.args ? `(${entry.args})` : ""}`;
	}
	if (entry.role === "toolResult") {
		const tag = entry.isError ? " [error]" : "";
		return `\u2190 ${entry.toolName}${tag}: ${(entry.text || "").slice(0, 500)}`;
	}
	if (entry.role === "tool") {
		return `\u2190 ${entry.toolName}: ${(entry.text || "").slice(0, 500)}`;
	}
	if (entry.role === "assistant") return `[assistant] ${(entry.text || "").slice(0, 1000)}`;
	return `[user] ${(entry.text || "").slice(0, 500)}`;
}

export function registerWorkflowStatusTool(pi: ExtensionAPI, workflowManager: WorkflowManager) {
	pi.registerTool({
		name: "workflow_status",
		label: "Workflow Status",
		description: [
			"Investigate a workflow run's status, errors, and agent history programmatically \u2014 without needing the interactive /workflows TUI.",
			"Use this after a workflow tool call reports a failure (especially a technical failure) to inspect exactly which agent failed, why, and what it was doing.",
			"Call with just runId for a summary of every agent's status/error. Call with runId + agentId for one agent's full prompt, result, error, and tool-call/output history.",
		].join(" "),
		parameters: WorkflowStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const run = workflowManager.getRun(params.runId);
			if (!run) {
				const persisted = workflowManager.listRuns().find((r) => r.runId === params.runId);
				if (!persisted) {
					return {
						content: [{ type: "text", text: `No workflow run found with runId "${params.runId}". It may have completed and been pruned, or the ID is incorrect.` }],
						details: { found: false },
					};
				}
				const lines = [
					`Workflow "${persisted.workflowName}" (${params.runId}) \u2014 status: ${persisted.status}`,
					`Total tokens: ${persisted.totalTokens}, duration: ${persisted.durationMs}ms`,
					"",
					"Agents:",
					...persisted.agents.map((a) => `  #${a.id} [${a.status}] ${a.label}${a.error ? ` \u2014 ERROR: ${a.error}` : ""}`),
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { found: true, persisted: true, run: persisted } };
			}

			const snapshot = run.snapshot;

			if (params.agentId !== undefined) {
				const agent = snapshot.agents.find((a) => a.id === params.agentId);
				if (!agent) {
					return {
						content: [{ type: "text", text: `No agent with id ${params.agentId} found in run "${params.runId}". Known agent IDs: ${snapshot.agents.map((a) => a.id).join(", ") || "(none)"}` }],
						details: { found: false },
					};
				}
				const limit = params.historyLimit ?? 100;
				const history = (agent.history ?? []).slice(0, limit);
				const truncatedNote = (agent.history?.length ?? 0) > limit ? `\n\n... (${(agent.history?.length ?? 0) - limit} more history entries not shown; increase historyLimit to see more)` : "";
				const resultText = agent.result !== undefined && agent.result !== null
					? (typeof agent.result === "string" ? agent.result : JSON.stringify(agent.result, null, 2))
					: (agent.resultPreview || "(no result yet)");
				const lines = [
					`Agent #${agent.id} "${agent.label}" (phase: ${agent.phase ?? "(none)"}) \u2014 status: ${agent.status}`,
					agent.model ? `Model: ${agent.model}` : undefined,
					agent.error ? `Error: ${agent.error}` : undefined,
					"",
					"Prompt:",
					agent.prompt || "(none)",
					"",
					"Result:",
					resultText,
					"",
					`History (${history.length}${(agent.history?.length ?? 0) > history.length ? ` of ${agent.history?.length}` : ""} entries):`,
					...history.map((e) => "  " + summarizeHistoryEntry(e)),
				].filter((l): l is string => l !== undefined);
				return {
					content: [{ type: "text", text: lines.join("\n") + truncatedNote }],
					details: { found: true, agent },
				};
			}

			const lines = [
				`Workflow "${snapshot.meta.name}" (${params.runId}) \u2014 status: ${snapshot.status}`,
				snapshot.error ? `Run error: ${snapshot.error}` : undefined,
				`Total agents: ${snapshot.totalAgents}, tokens: ${snapshot.totalTokens}`,
				"",
				"Agents:",
				...snapshot.agents.map((a) => {
					const errSuffix = a.error ? ` \u2014 ERROR: ${a.error}` : "";
					const resultSuffix = !a.error && a.resultPreview ? ` \u2014 ${a.resultPreview}` : "";
					return `  #${a.id} [${a.status}] ${a.label} (phase: ${a.phase ?? "(none)"})${errSuffix}${resultSuffix}`;
				}),
				"",
				"Pass agentId to this tool to get one agent's full prompt, result, and tool-call/output history.",
			].filter((l): l is string => l !== undefined);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { found: true, run: snapshot },
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	const globalWorkflowManager = new WorkflowManager();

	// --- Subagent Tool ---
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array).",
			`Discovers agents from both ${path.join(getAgentDir(), "agents")} (user) and ${CONFIG_DIR_NAME}/agents (project).`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const forkContext: ForkContextOptions | undefined = ctx.model
				? { sessionManager: ctx.sessionManager, modelRegistry: ctx.modelRegistry, fallbackModel: ctx.model }
				: undefined;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode (single: agent+task, or parallel: tasks array).\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Confirm project agents if needed
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`This will run agents from project directory: ${dir}\nAgents: ${names}\n\nAllow?`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Project-local agent execution cancelled." }],
							details: makeDetails("single")([]),
						};
					}
				}
			}

			// Parallel mode
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many tasks. Maximum: ${MAX_PARALLEL_TASKS}, got: ${params.tasks.length}` },
						],
						details: makeDetails("parallel")([]),
					};
				}

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, _index) => {
						const agent = agents.find((a) => a.name === t.agent);
						if (!agent) {
							return {
								agent: t.agent,
								task: t.task,
								exitCode: 1,
								messages: [],
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
								error: `Unknown agent: ${t.agent}`,
							} as SingleResult;
						}
						return await runSingleAgent(
							ctx.cwd,
							agent,
							t.task,
							{
								runId: `parallel-${Date.now()}-${_index}`,
								cwd: t.cwd,
								signal,
								parentSessionId: ctx.sessionManager.getSessionId(),
								context: t.context,
								forkContext,
							},
						);
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = isFailedResult(r)
						? `✗ failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "✓ completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			if (params.agent && params.task) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available agents: ${available}` }],
						details: makeDetails("single")([]),
					};
				}
				const result = await runSingleAgent(
					ctx.cwd,
					agent,
					params.task,
					{
						runId: `single-${Date.now()}`,
						cwd: params.cwd,
						signal,
						parentSessionId: ctx.sessionManager.getSessionId(),
						context: params.context,
						forkContext,
					},
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},
	});

	// --- Workflow Tool ---
	// Graph-based coordination: nodes are agents, edges decide where each
	// result goes next. Replaces the imperative agent()/parallel() script.
	//
	// The manager is passed in so runs appear in /workflows, the task panel,
	// and workflow_status. Without it the tool still runs, but every one of
	// those surfaces reports an empty run list.
	const workflowTool = createGraphWorkflowTool({ workflowManager: globalWorkflowManager });
	pi.registerTool(workflowTool);
	registerWorkflowStatusTool(pi, globalWorkflowManager);

	// --- Agent Catalog ---
	pi.registerTool(createListAgentsTool());

	/**
	 * Injects the live agent roster into the delegation tools' guidelines.
	 *
	 * Discovery has always worked, but nothing told the model which agents
	 * exist: /agents renders to the human's screen, and the tool guidelines
	 * never enumerated the roster. Since resolveAgent() silently falls back to
	 * a generic agent for an unknown name, a guessed name produced a plausible
	 * wrong run rather than an error.
	 *
	 * Re-registering a tool refreshes it in place, so this runs at session_start
	 * once the cwd is known, and again whenever the roster may have changed.
	 */
	const refreshAgentCatalogGuidelines = (cwd: string): void => {
		let guideline: string;
		try {
			guideline = buildAgentCatalogGuideline(discoverAgents(cwd, "both").agents);
		} catch {
			// Never let a malformed agent file take down tool registration.
			return;
		}

		pi.registerTool({
			...workflowTool,
			promptGuidelines: [...(workflowTool.promptGuidelines ?? []), guideline],
		});
	};

	// --- Commands ---
	pi.registerCommand("workflows", {
		description: "Open the interactive /workflows navigator overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /workflows navigator requires an interactive TUI session.", "warning");
				return;
			}
			await openWorkflowNavigator(pi, globalWorkflowManager, ctx.ui);
		},
	});

	pi.registerCommand("saved-workflows", {
		description: "List saved workflows (or `/saved-workflows delete <name>` to remove one)",
		handler: async (args, ctx) => {
			const runCwd = ctx.cwd;
			const trimmed = (args || "").trim();
			if (trimmed.startsWith("delete ")) {
				const name = trimmed.slice("delete ".length).trim();
				if (!name) {
					ctx.ui.notify("Usage: /saved-workflows delete <name>", "warning");
					return;
				}
				const removed = deleteSavedWorkflow(runCwd, name);
				ctx.ui.notify(removed ? `Deleted saved workflow "${name}".` : `No saved workflow named "${name}" found.`, removed ? "info" : "warning");
				return;
			}

			const saved = listSavedWorkflows(runCwd);
			if (saved.length === 0) {
				ctx.ui.notify(
					'No saved workflows yet. Run the workflow tool with saveWorkflow: true to persist a script to .pi-workflow/workflows/ for reuse via loadWorkflow.',
					"info",
				);
				return;
			}

			const lines = ["Saved workflows (.pi-workflow/workflows/):", ""];
			for (const wf of saved) {
				const savedAgo = new Date(wf.savedAt).toISOString();
				lines.push(`• ${wf.name}`);
				lines.push(`  ${wf.description}`);
				if (wf.whenToUse) lines.push(`  When to use: ${wf.whenToUse}`);
				lines.push(`  Saved: ${savedAgo} · ${wf.sizeBytes}B · loadWorkflow: "${wf.name}"`);
				lines.push("");
			}
			ctx.ui.setWidget("saved-workflows", lines);
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Create agent files in ~/.pi/agent/agents/*.md or .pi/agents/*.md", "info");
				return;
			}

			const lines = ["Available subagents:", ""];
			for (const agent of agents) {
				const parts = [`• ${agent.name}`];
				if (agent.package) parts.push(`(pkg: ${agent.package})`);
				if (agent.model) parts.push(`[model: ${agent.model}]`);
				if (agent.tools) parts.push(`[tools: ${agent.tools.join(", ")}]`);
				if (agent.thinking) parts.push(`[thinking: ${agent.thinking}]`);
				if (agent.extensions !== undefined) {
					parts.push(`[extensions: ${agent.extensions.length || "none"}]`);
				}
				if (agent.subagentOnlyExtensions) {
					parts.push(`[subagent-exts: ${agent.subagentOnlyExtensions.join(", ")}]`);
				}
				if (agent.skills) parts.push(`[skills: ${agent.skills.join(", ")}]`);
				if (agent.async) parts.push(`[async]`);
				if (agent.memory) parts.push(`[memory: ${agent.memory.scope}/${agent.memory.path}]`);
				const source = agent.source === "project" ? " (project)" : "";
				lines.push(parts.join(" ") + source);
				lines.push(`  ${agent.description}`);
				lines.push("");
			}
			ctx.ui.setWidget("agents", lines);
		},
	});

	// --- Workflow-only mode: /workflow on|off ---
	registerWorkflowMode(pi, { workflowToolName: workflowTool.name, subagentToolName: "subagent" });

	// --- Session start: activate workflow tool & task panel ---
	pi.on("session_start", (_event, ctx) => {
		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}
		if (ctx?.cwd) {
			refreshAgentCatalogGuidelines(ctx.cwd);
		}
		if (ctx && ctx.ui) {
			registerTaskPanel(pi, globalWorkflowManager, ctx.ui);
		}
	});
}
