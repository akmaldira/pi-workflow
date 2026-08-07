/**
 * The `workflow` tool — graph-based multi-agent coordination.
 *
 * Assembles the pieces: validate the script (before any agent spawns),
 * build the run context, walk the graph, journal each node, and report.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildAgentCatalogSummary } from "./agent-catalog.ts";
import { discoverAgents } from "./agents.ts";
import type { GraphState } from "./graph-dsl.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	formatPath,
	type GraphRunResult,
	type NodeExecution,
	runGraph,
} from "./graph-executor.ts";
import {
	GraphJournal,
	graphScriptHash,
	loadGraphResumeState,
	loadGraphSuperstepResumeState,
} from "./graph-journal.ts";
import {
	runSuperstepGraph,
	type SuperstepResumeInput,
} from "./graph-superstep-executor.ts";
import { createNodeRunner, type InteractiveHandlers } from "./graph-node-runner.ts";
import { createInteractiveHandlers } from "./graph-interactive.ts";
import { GraphRunContext } from "./graph-run-context.ts";
import { buildGraphFromScript, GraphValidationError } from "./graph-validator.ts";
import { GraphDisplayBridge } from "./graph-display-bridge.ts";
import { loadSavedWorkflowScript, saveWorkflowScript } from "./workflow-library.ts";
import type { WorkflowManager } from "./workflow-manager.ts";
import type { ForkContextOptions } from "./types.ts";
import { runSingleAgent } from "./execution.ts";

const GraphToolParams = Type.Object({
	script: Type.Optional(
		Type.String({
			description:
				"Graph workflow script. Must begin with `export const meta = { name, description }`. " +
			"Create a graph with graph(), define nodes with g.node(id, agent(name, promptFn) | mainAgent(prompt) | human(prompt, opts)), " +
				"route with g.edge(from, to | (state, result) => target), and start it with g.run({ ... }). " +
				"Required unless loadWorkflow names a saved graph.",
		}),
	),
	args: Type.Optional(
		Type.Any({
			description: "Values available to the script as `args`. Must be JSON-serialisable.",
		}),
	),
	maxIterations: Type.Optional(
		Type.Number({
			description: `Cap before the run stops. Default ${DEFAULT_MAX_ITERATIONS}. Counts node executions in a linear graph, and rounds (parallel waves) in a graph with fan-out. Raise it for graphs with legitimate long loops.`,
		}),
	),
	tokenBudget: Type.Optional(
		Type.Number({
			description:
				"Soft token budget. Warnings are reported at 80% and when exceeded; the run is never killed.",
		}),
	),
	useWorktree: Type.Optional(
		Type.Boolean({
			description:
				"Run agents inside an isolated git worktree so the project tree is untouched until you review the result. Default false.",
		}),
	),
	resumeRunId: Type.Optional(
		Type.String({
			description:
				"Resume a previous run, skipping nodes that already completed. Requires an unchanged script.",
		}),
	),
	loadWorkflow: Type.Optional(
		Type.String({
			description:
				"Run a previously saved graph by name instead of passing `script`. See /saved-workflows for what exists.",
		}),
	),
	saveWorkflow: Type.Optional(
		Type.Boolean({
			description:
				"Persist this graph under meta.name after a successful run so it can be re-run later with loadWorkflow. Default false.",
		}),
	),
});

export interface GraphToolOptions {
	/** Overrides ctx.cwd. Primarily for tests. */
	cwd?: string;
	/** Injected so tests can run graphs without spawning processes. */
	spawnAgent?: typeof runSingleAgent;
	/**
	 * Feeds run progress to /workflows, the task panel, and workflow_status.
	 * Optional so the tool stays usable headless and in tests.
	 */
	workflowManager?: WorkflowManager;
	/**
	 * Overrides the ctx-derived interactive handlers. Tests inject stubs;
	 * production leaves it unset so human()/mainAgent() reach the real UI.
	 */
	handlers?: InteractiveHandlers;
	onRunStart?: (info: { runId: string; name: string; nodeIds: string[] }) => void;
	onNodeStart?: (info: { step: number; nodeId: string; nodeType: string }) => void;
	onNodeComplete?: (execution: NodeExecution) => void;
	onRunComplete?: (result: GraphRunResult) => void;
}

function summariseResult(value: unknown, limit = 400): string {
	if (value === null || value === undefined) return "(no result)";
	const text = typeof value === "string" ? value : String(value);
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Renders the walk with each node's outcome.
 *
 * The path is the most useful thing to report: it shows which agents ran,
 * in what order, and where escalations sent work back.
 */
function formatHistory(history: NodeExecution[]): string {
	if (history.length === 0) return "(no nodes ran)";

	return history
		.map((execution) => {
			const who = execution.agentName ? `${execution.nodeId} (${execution.agentName})` : execution.nodeId;
			const arrow = execution.routedTo ? ` -> ${execution.routedTo}` : "";
			const marker = execution.status === "failed" ? " [failed]" : "";
			const detail = execution.error ? ` — ${execution.error}` : "";
			return `  ${execution.step}. ${who}${marker}${arrow}${detail}`;
		})
		.join("\n");
}

/**
 * Reports blocked outcomes separately.
 *
 * A blocked agent is the signal this whole design exists to surface: it
 * means an agent hit a real wall and said so instead of faking progress.
 * Burying it in the walk would waste the escalation.
 */
function formatEscalations(state: GraphState): string {
	const escalations: string[] = [];

	for (const [nodeId, value] of Object.entries(state)) {
		if (!value || typeof value !== "object") continue;
		const result = value as { status?: string; blockedOn?: string; reason?: string };
		if (result.status !== "blocked") continue;

		const target = result.blockedOn ? ` (blocked on: ${result.blockedOn})` : "";
		const reason = result.reason ? ` — ${result.reason}` : "";
		escalations.push(`  ${nodeId}${target}${reason}`);
	}

	return escalations.join("\n");
}

export function createGraphWorkflowTool(options: GraphToolOptions = {}): ToolDefinition {
	const spawnAgent = options.spawnAgent ?? runSingleAgent;

	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Run a graph of coordinating agents. Nodes are agents; edges decide where each result goes next.",
			"Agents coordinate through routing and shared state: when one reports it is blocked, an edge can send the work back to whoever can resolve it, and that agent sees the blocker in the state it receives.",
			"Use it for multi-step work where the path is not known in advance. For a single delegation, use the subagent tool instead.",
		].join(" "),
		promptSnippet:
			"Run a coordinating graph of agents. Required header: export const meta = { name, description }. Nodes are agent()/mainAgent()/human(); edges are direct or (state, result) => target.",
		promptGuidelines: [
			"For workflow, write the script as one raw JavaScript string with no Markdown fences or surrounding prose.",
			"For workflow, the first statement must be `export const meta = { name: 'short_snake_case', description: 'what this graph does' }`.",
			"For workflow, available globals are graph, agent, mainAgent, human, END, args, and JSON. There is no fs, process, require, import, fetch, Date, or Math.random — a graph describes routing only.",
			"For workflow, define every node before routing it and make sure some path reaches END. A node normally has one outgoing edge; give it several to fan out and run those branches in parallel.",
			"For workflow, parallel branches run concurrently in rounds. A node with several incoming edges waits for ALL of them before running, so it never sees partial work. Each branch's result lands under its own node id, so give branches distinct ids rather than writing shared state keys.",
			"For workflow, a node's prompt function receives the accumulated state, where each previous node's result is stored under its node id: agent('green', (s) => `Implement:\\n${s.architect}`).",
			"For workflow, use a conditional edge when the next step depends on what an agent produced: g.edge('green', (state, result) => result.status === 'blocked' ? 'architect' : 'reviewer').",
			"For workflow, agent results carry { status, text, blockedOn, reason } — status is 'blocked' when the agent escalated. Interpolating a result into a prompt yields its text.",
			"For workflow, prefer routing a blocked agent back to whoever owns the problem (contract issues to the designer, test issues to whoever wrote them) rather than retrying the same node.",
			"For workflow, cycles are allowed and are how escalation works; the run stops at maxIterations if a loop never resolves.",
			"For workflow, use mainAgent(prompt) to pause for your own judgement mid-run, and human(prompt, { options, default }) to ask the user. Always give human() a default so a headless run cannot hang.",
		],
		parameters: GraphToolParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = options.cwd ?? ctx.cwd;

			let script: string;
			if (params.loadWorkflow) {
				const saved = loadSavedWorkflowScript(cwd, params.loadWorkflow);
				if (!saved) {
					throw new Error(
						`No saved workflow named "${params.loadWorkflow}". Use /saved-workflows to see what exists, or pass a script.`,
					);
				}
				script = saved;
			} else if (params.script) {
				script = params.script;
			} else {
				throw new Error("workflow requires either `script` or `loadWorkflow`.");
			}

			const scriptHash = graphScriptHash(script);

			// Validate first: a bad script must cost nothing.
			let built: ReturnType<typeof buildGraphFromScript>;
			try {
				built = buildGraphFromScript(script, { args: params.args });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const roster =
					error instanceof GraphValidationError
						? `\n\n${buildAgentCatalogSummary(discoverAgents(cwd, "both").agents)}`
						: "";
				// Throw rather than returning isError: the agent loop derives a
				// tool result's error status from whether execute() threw and
				// ignores a returned isError field, so returning one would report
				// this failure to the model as a success containing error text.
				throw new Error(`Graph was not run.\n\n${message}${roster}`);
			}

			const { meta, graph } = built;
			// A graph with any fan-out node runs in parallel rounds; everything
			// else keeps the linear walk. The two executors have incompatible
			// iteration semantics (rounds vs steps), so the choice is made once
			// here and threaded through resume, journaling, and reporting.
			const isSuperstep = graph.mode === "superstep";
			const nodeIds = [...graph.nodes.keys()];
			const runId = params.resumeRunId ?? `graph-${Date.now()}`;
			const journalDir = `${cwd}/.pi-workflow/runs`;

			// Resolve resume before doing any work, so a stale resume fails fast.
			const alreadyComplete = {
				content: [
					{
						type: "text" as const,
						text: `Run "${params.resumeRunId}" already completed; there is nothing to resume.`,
					},
				],
				details: { resumed: false, alreadyComplete: true },
			};

			let resume: Parameters<typeof runGraph>[1]["resume"];
			let superstepResume: SuperstepResumeInput | undefined;

			if (params.resumeRunId && isSuperstep) {
				// Superstep resume is round-atomic: it continues from the frontier
				// snapshotted at the last completed barrier.
				const resumeState = loadGraphSuperstepResumeState({
					journalDir,
					runId: params.resumeRunId,
					scriptHash,
				});

				if (!resumeState.isValid) {
					throw new Error(`Cannot resume: ${resumeState.invalidReason}`);
				}
				if (resumeState.frontier.length === 0) return alreadyComplete;

				superstepResume = {
					state: resumeState.state,
					resumeFromFrontier: resumeState.frontier,
					remainingInDegree: resumeState.remainingInDegree,
					completedRounds: resumeState.completedRounds,
					completedNodeExecutions: resumeState.completedNodeExecutions,
					executedNodeIds: resumeState.executedNodeIds,
				};
			} else if (params.resumeRunId) {
				const resumeState = loadGraphResumeState({
					journalDir,
					runId: params.resumeRunId,
					scriptHash,
				});

				if (!resumeState.isValid) {
					throw new Error(`Cannot resume: ${resumeState.invalidReason}`);
				}
				if (resumeState.resumeFrom === null) return alreadyComplete;

				resume = {
					state: resumeState.state,
					resumeFrom: resumeState.resumeFrom,
					completedSteps: resumeState.completedSteps,
				};
			}

			const context = new GraphRunContext({
				cwd,
				runId,
				tokenBudget: params.tokenBudget,
				useWorktree: params.useWorktree,
			});

			const journal = GraphJournal.create({
				journalDir,
				runId,
				scriptHash,
				name: meta.name,
				description: meta.description,
				entry: graph.entry,
				nodeIds,
				initialState: graph.initialState,
			});

			// Point the manager at this run's journal directory so
			// workflow_status and /workflows can look up completed runs by
			// runId even after this process exits (each call may use a
			// different cwd, so this is set per-run rather than once at
			// extension init — see workflow-manager.ts's setJournalDir()).
			options.workflowManager?.setJournalDir(journalDir);

			const display = options.workflowManager
				? new GraphDisplayBridge({
						manager: options.workflowManager,
						runId,
						name: meta.name,
						description: meta.description,
						script,
						cwd,
					})
				: undefined;

			options.onRunStart?.({ runId, name: meta.name, nodeIds });

			const forkContext: ForkContextOptions | undefined = ctx.model
				? {
						sessionManager: ctx.sessionManager,
						modelRegistry: ctx.modelRegistry,
						fallbackModel: ctx.model,
					}
				: undefined;

			// Shared by both executors: the node runner and per-node callbacks are
			// identical, so only the walk itself differs.
			const runNode = createNodeRunner({
				cwd: context.cwd,
				runId,
				signal,
				forkContext,
				artifactsDir: context.artifactsDir,
				artifactConfig: context.artifactConfig,
				spawnAgent: spawnAgent as never,
				// Built from ctx so human() actually asks and mainAgent()
				// actually checkpoints. Both degrade to their defaults when
				// the run has no UI.
				handlers:
					options.handlers ??
					createInteractiveHandlers({
						ctx,
						onEvent: (message) => display?.log(message),
					}),
			});

			const onNodeStart = (info: {
				step: number;
				nodeId: string;
				nodeType: string;
				round?: number;
			}): void => {
				const def = graph.nodes.get(info.nodeId)?.def;
				display?.nodeStarted({
					...info,
					agentName: def?.type === "agent" ? def.agentName : undefined,
				});
				options.onNodeStart?.(info);
			};

			const onNodeComplete = (execution: NodeExecution): void => {
				journal.recordNode(execution);
				context.recordNode(execution);
				display?.nodeCompleted(execution);
				options.onNodeComplete?.(execution);
			};

			let result: GraphRunResult;
			/** Node executions. Diverges from iterations only for superstep runs. */
			let nodeExecutions: number;
			try {
				if (isSuperstep) {
					const superstepResult = await runSuperstepGraph(graph, {
						runId,
						signal,
						maxIterations: params.maxIterations,
						resume: superstepResume,
						runNode,
						onNodeStart,
						onNodeComplete,
						onRoundComplete: (info) => {
							// The barrier marker is what makes a crashed parallel run
							// resumable: it records the frontier and readiness counters.
							journal.recordRoundComplete(info);
							display?.roundComplete(info);
						},
					});
					nodeExecutions = superstepResult.nodeExecutions;
					result = superstepResult;
				} else {
					result = await runGraph(graph, {
						runId,
						signal,
						maxIterations: params.maxIterations,
						resume,
						runNode,
						onNodeStart,
						onNodeComplete,
					});
					// In a linear walk one step is one node execution.
					nodeExecutions = result.iterations;
				}
			} finally {
				context.cleanup();
			}

			journal.recordResult({
				status: result.status,
				iterations: result.iterations,
				nodeExecutions: isSuperstep ? nodeExecutions : undefined,
				durationMs: result.durationMs,
				error: result.error,
			});
			display?.runCompleted(result);
			options.onRunComplete?.(result);

			// Only persist a graph that actually worked: saving a broken one
			// would offer it for reuse under a name that implies it runs.
			let savedAs: string | undefined;
			if (params.saveWorkflow && result.status === "completed") {
				try {
					savedAs = saveWorkflowScript(cwd, script, meta).name;
				} catch {
					// Reported below; a save failure must not fail the run.
				}
			}

			const summary = context.summary();
			const lines: string[] = [];

			// A superstep run reports both counters: rounds measure how deep the
			// coordination went, node executions measure how much work happened.
			// Collapsing them would make a 5-node round read as a single step.
			const completedSummary = isSuperstep
				? `${nodeExecutions} node execution${nodeExecutions === 1 ? "" : "s"} across ${result.iterations} round${result.iterations === 1 ? "" : "s"}`
				: `${result.iterations} step${result.iterations === 1 ? "" : "s"}`;
			const heading =
				result.status === "completed"
					? `Graph "${meta.name}" completed in ${completedSummary}.`
					: result.status === "max_iterations"
						? `Graph "${meta.name}" stopped at the ${isSuperstep ? "round" : "iteration"} cap.`
						: `Graph "${meta.name}" aborted.`;
			lines.push(heading);

			if (result.error) lines.push(`\n${result.error}`);

			lines.push(`\nPath: ${formatPath(result)}`);
			lines.push(`\nNodes:\n${formatHistory(result.history)}`);

			const escalations = formatEscalations(result.state);
			if (escalations) {
				lines.push(`\nEscalations reported:\n${escalations}`);
			}

			if (result.status === "completed") {
				lines.push(`\nFinal result:\n${summariseResult(result.finalResult)}`);
			}

			for (const warning of summary.warnings) {
				lines.push(`\n⚠ ${warning.message}`);
			}
			if (summary.worktreeSkipped) {
				lines.push(`\nNote: ${summary.worktreeSkipped}`);
			}
			if (journal.writeErrors.length > 0) {
				lines.push(`\nNote: the run journal could not be written (${journal.writeErrors[0]}).`);
			}

			if (savedAs) {
				lines.push(`\nSaved as "${savedAs}"; re-run it later with loadWorkflow: "${savedAs}".`);
			} else if (params.saveWorkflow && result.status !== "completed") {
				lines.push("\nNot saved: only graphs that complete successfully are persisted.");
			}

			lines.push(`\nRun ID: ${runId}${result.status !== "completed" ? " (resumable)" : ""}`);

			// An aborted run throws so the model sees a failed tool call rather
			// than a successful one whose text happens to describe a failure. The
			// full report is preserved in the message, including the resumable run
			// id, so nothing is lost by throwing.
			if (result.status === "aborted") {
				throw new Error(lines.join("\n"));
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					runId,
					name: meta.name,
					status: result.status,
					mode: graph.mode,
					iterations: result.iterations,
					nodeExecutions,
					path: result.path,
					durationMs: result.durationMs,
					budget: summary.budget,
					state: result.state,
					error: result.error,
				},
			};
		},
	});
}
