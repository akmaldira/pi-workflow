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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { createWorkflowTool } from "./workflow-tool.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: any[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	results: SingleResult[];
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
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

/**
 * Build pi CLI args from an agent config, mapping frontmatter attributes to flags.
 * Based on pi-subagents' pi-args.ts buildPiArgs function.
 */
function buildPiArgs(agent: AgentConfig, task: string): { args: string[]; tmpDirs: string[] } {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const tmpDirs: string[] = [];

	// Model configuration (with thinking suffix)
	let modelArg: string | undefined;
	if (agent.model) {
		if (agent.thinking) {
			const colonIdx = agent.model.lastIndexOf(":");
			const hasThinkingLevel = colonIdx !== -1 && ["low", "medium", "high"].includes(agent.model.substring(colonIdx + 1));
			modelArg = hasThinkingLevel ? `${agent.model.slice(0, colonIdx)}:${agent.thinking}` : `${agent.model}:${agent.thinking}`;
		} else {
			modelArg = agent.model;
		}
		args.push("--model", modelArg);
	}

	// Tool configuration
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	// Extension configuration
	if (agent.extensions !== undefined) {
		if (agent.extensions.length === 0) {
			args.push("--no-extensions");
		} else {
			for (const ext of agent.extensions) {
				args.push("--extension", ext);
			}
		}
	}

	// Subagent-only extensions (loaded only for child sessions)
	if (agent.subagentOnlyExtensions) {
		for (const ext of agent.subagentOnlyExtensions) {
			args.push("--extension", ext);
		}
	}

	// Skills configuration
	if (agent.inheritSkills === false) {
		args.push("--no-skills");
	}
	if (agent.skills && agent.skills.length > 0) {
		for (const skill of agent.skills) {
			args.push("--skill", skill);
		}
	}

	// Skill paths
	if (agent.skillPath) {
		for (const sp of agent.skillPath) {
			args.push("--skill", sp);
		}
	}

	// Inherit project context
	if (agent.inheritProjectContext === false) {
		args.push("--no-context-files");
	}

	// Default reads (prepend file reading instructions to task)
	if (agent.defaultReads && agent.defaultReads.length > 0) {
		task = agent.defaultReads.map((f) => `\n\n[Reading ${f}]\n`).join("") + task;
	}

	// System prompt
	let tmpPromptDir: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpDirs.push(tmp.dir);
		if (agent.systemPromptMode === "replace") {
			args.push("--system-prompt", tmp.filePath);
		} else {
			args.push("--append-system-prompt", tmp.filePath);
		}
	}

	// Task argument (truncate if too long)
	const TASK_ARG_LIMIT = 8000;
	if (task.length > TASK_ARG_LIMIT) {
		const tmp = await writePromptToTempFile(agent.name, `Task: ${task}`);
		tmpDirs.push(tmp.dir);
		args.push(`@${tmp.filePath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	return { args, tmpDirs };
}

/**
 * Run a single subagent and return the full result object.
 */
async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	agentConfig?: AgentConfig,
): Promise<SingleResult> {
	const agent = agentConfig || agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
	};

	let tmpDirs: string[] = [];
	try {
		const { args, tmpDirs: dirs } = await buildPiArgs(agent, task);
		tmpDirs = dirs;

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: cwd ?? defaultCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const abortHandler = () => {
			proc.kill("SIGKILL");
		};
		signal?.addEventListener("abort", abortHandler);

		let stdout = "";
		let stderr = "";
		let stderrBuffer = "";

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderrBuffer += chunk.toString();
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() ?? "";
			stderr += lines.join("\n") + "\n";
		});

		result.exitCode = await new Promise<number>((resolve) => {
			proc.on("close", (code) => {
				resolve(code ?? 1);
			});
			proc.on("error", () => {
				resolve(1);
			});
		});

		signal?.removeEventListener("abort", abortHandler);

		// Parse JSON output
		for (const line of stdout.split("\n").filter(Boolean)) {
			try {
				const event = JSON.parse(line);
				if (event.type === "message") {
					result.messages.push(event.message);
				}
				if (event.type === "error") {
					result.errorMessage = event.message;
					result.stopReason = "error";
				}
				if (event.type === "done") {
					result.usage = event.usage || result.usage;
					result.stopReason = event.stopReason || "end";
				}
				if (event.type === "abort") {
					result.stopReason = "aborted";
				}
			} catch {
				// ignore parse errors
			}
		}

		if (result.stopReason === "aborted") {
			result.exitCode = 130; // SIGINT exit code
		}
	} catch (e) {
		result.exitCode = 1;
		result.errorMessage = (e as Error).message;
		result.stopReason = "error";
	} finally {
		for (const dir of tmpDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	return result;
}

/**
 * Run a single subagent and return just the output text.
 * Used by the workflow tool's agent() global.
 */
async function runSubagentForWorkflow(
	cwd: string,
	agent: AgentConfig,
	task: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const agents: AgentConfig[] = [agent];
	const result = await runSingleAgent(cwd, agents, agent.name, task, cwd, signal, agent);
	return getResultOutput(result);
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
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
});

export default function (pi: ExtensionAPI) {
	// --- Subagent Tool ---
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

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
							throw new Error(`Unknown agent: ${t.agent}`);
						}
						return await runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, signal, agent);
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
					agents,
					params.agent,
					params.task,
					params.cwd,
					signal,
					agent,
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
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
	const workflowTool = createWorkflowTool({
		cwd: undefined, // will use ctx.cwd at execution time
		runSingleAgent: runSubagentForWorkflow,
	});
	pi.registerTool(workflowTool);

	// --- Commands ---
	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "user");
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Create agent files in ~/.pi/agent/agents/*.md", "info");
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

	// --- Session start: activate workflow tool ---
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}
	});
}
