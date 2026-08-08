/**
 * The `workflow` tool — graph-based multi-agent coordination.
 *
 * The tool validates and detaches. It parses the script, checks it against the
 * agent roster, resolves resume state, and then starts the walk *without
 * awaiting it*, returning a run id so the turn can end immediately.
 *
 * There is no foreground mode. A blocking run would leave the main agent stuck
 * inside this call for the whole walk, which is precisely what makes
 * `ask_supervisor` impossible: an agent that cannot take a turn cannot answer a
 * question. Offering both modes would mean every downstream feature has to
 * document which of them it works in.
 *
 * The report is delivered back into the conversation when the walk finishes
 * (see result-delivery.ts).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildAgentCatalogSummary } from "./agent-catalog.ts";
import { discoverAgents } from "./agents.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	type GraphRunResult,
	type NodeExecution,
} from "./graph-executor.ts";
import {
	graphScriptHash,
	loadGraphSuperstepResumeState,
} from "./graph-journal.ts";
import type { SuperstepResumeInput } from "./graph-executor.ts";
import { createNodeRunner, type InteractiveHandlers } from "./graph-node-runner.ts";
import { createInteractiveHandlers } from "./graph-interactive.ts";
import { buildGraphFromScript, GraphValidationError } from "./graph-validator.ts";
import { GraphDisplayBridge } from "./graph-display-bridge.ts";
import type { GraphRunContext } from "./graph-run-context.ts";
import { executeGraphRun, type GraphRunReport } from "./graph-run.ts";
import { stageRunReport } from "./result-delivery.ts";
import { loadSavedWorkflowScript } from "./workflow-library.ts";
import type { WorkflowManager } from "./workflow-manager.ts";
import type { RequestBroker } from "./request-broker.ts";
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
	allowConcurrentDuplicate: Type.Optional(
		Type.Boolean({
			description:
				"Start this graph even though another run of the same name is already in flight. Default false, because a same-name collision is almost always an accidental double-submit.",
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
	 * production leaves it unset so human() reaches the real UI.
	 */
	handlers?: InteractiveHandlers;
	onRunStart?: (info: { runId: string; name: string; nodeIds: string[] }) => void;
	onNodeStart?: (info: { step: number; nodeId: string; nodeType: string }) => void;
	onNodeComplete?: (execution: NodeExecution) => void;
	onRunComplete?: (result: GraphRunResult) => void;
	/**
	 * Called with the detached run's promise.
	 *
	 * The tool cannot await the walk — that is the whole point — so tests need
	 * a handle on it to know when it finished. Production ignores it; delivery
	 * happens through the manager's completion events instead.
	 */
	onRunDetached?: (info: { runId: string; done: Promise<GraphRunReport | undefined> }) => void;
	/** The broker for judgement requests from child processes. */
	broker?: RequestBroker;
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
			const nodeIds = [...graph.nodes.keys()];

			// Check the roster before detaching. Once the run is in the background
			// its failures are reported in a message rather than by failing this
			// call, and a misspelled agent name is exactly the kind of mistake the
			// model should be told about immediately, while it can still fix it.
			{
				const named = new Set<string>();
				for (const node of graph.nodes.values()) {
					if (node.def.type === "agent") named.add(node.def.agentName);
				}
				if (named.size > 0) {
					const roster = discoverAgents(cwd, "both").agents;
					const known = new Set(roster.map((a) => a.name));
					const unknown = [...named].filter((name) => !known.has(name)).sort();
					if (unknown.length > 0) {
						const available = roster.map((a) => a.name).sort().join(", ") || "(none)";
						const subject =
							unknown.length === 1
								? `Unknown agent "${unknown[0]}"`
								: `Unknown agents ${unknown.map((n) => `"${n}"`).join(", ")}`;
						throw new Error(
							`Graph was not run.\n\n${subject}. Available agents: ${available}.`,
						);
					}
				}
			}
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

			let superstepResume: SuperstepResumeInput | undefined;

			if (params.resumeRunId) {
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
			}

			// Point the manager at this run's journal directory so
			// workflow_status and /workflows can look up completed runs by
			// runId even after this process exits (each call may use a
			// different cwd, so this is set per-run rather than once at
			// extension init — see workflow-manager.ts's setJournalDir()).
			options.workflowManager?.setJournalDir(journalDir);

			// Refuse before spawning anything. Both guards report what is already
			// running so the model can decide whether to wait or stop something,
			// rather than being told only that it may not proceed.
			if (options.workflowManager && !params.resumeRunId) {
				const permitted = options.workflowManager.checkCanStart(meta.name, {
					allowDuplicateName: params.allowConcurrentDuplicate,
				});
				if (!permitted.ok) throw new Error(permitted.reason);
			}

			// The run outlives this tool call, so it cannot use the call's signal:
			// that aborts the moment execute() returns. It gets its own controller,
			// which /workflows and stopRun() reach through the manager.
			const runAbort = new AbortController();

			const display = options.workflowManager
				? new GraphDisplayBridge({
						manager: options.workflowManager,
						runId,
						name: meta.name,
						description: meta.description,
						script,
						cwd,
						abortController: runAbort,
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

			// Built per-run rather than once: the runner needs the run context's
			// cwd, which is the worktree path when the run is isolated.
			const makeRunNode = (context: GraphRunContext) =>
				createNodeRunner({
					cwd: context.cwd,
					runId,
					signal: runAbort.signal,
					forkContext,
					parentSessionId:
						ctx.sessionManager?.getSessionId() ?? process.env.PI_SUBAGENT_PARENT_SESSION,
					artifactsDir: context.artifactsDir,
					artifactConfig: context.artifactConfig,
					extraEnv: context.extraEnv,
					spawnAgent: spawnAgent as never,
					// Built from ctx so human() actually asks. It degrades to the
					// node's default when the run has no UI.
					handlers:
						options.handlers ??
						createInteractiveHandlers({
							ctx,
							onEvent: (message) => display?.log(message),
						}),
				});

			// Detach. Everything below this line happens after the tool has
			// returned and the turn has ended.
			const done = executeGraphRun({
				runId,
				cwd,
				script,
				scriptHash,
				meta,
				graph,
				journalDir,
				signal: runAbort.signal,
				maxIterations: params.maxIterations,
				tokenBudget: params.tokenBudget,
				useWorktree: params.useWorktree,
				saveWorkflow: params.saveWorkflow,
				resume: superstepResume,
				makeRunNode,
				display,
				broker: options.broker,
				onNodeStart: options.onNodeStart,
				onNodeComplete: options.onNodeComplete,
				onRunComplete: options.onRunComplete,
			})
				.then((report) => {
					// Staged before the display marks the run complete, because
					// that is what fires the event delivery listens for.
					if (options.workflowManager) stageRunReport(options.workflowManager, report);
					display?.runCompleted(report.result);
					return report;
				})
				.catch((error: unknown) => {
					// A detached run has no tool call left to fail, so a crash has to
					// be reported through the manager or it vanishes silently.
					const message = error instanceof Error ? error.message : String(error);
					display?.runFailed(message);
					return undefined;
				});

			// Never let the detached promise reject unhandled: that crashes the
			// whole pi process, taking the user's session with it.
			void done.catch(() => {});
			options.onRunDetached?.({ runId, done });

			const nodeList = nodeIds.join(" -> ");
			const started = params.resumeRunId
				? `Resumed workflow "${meta.name}" in the background.`
				: `Workflow "${meta.name}" started in the background.`;

			return {
				content: [
					{
						type: "text" as const,
						text: [
							started,
							`  runId: ${runId}`,
							`  nodes: ${nodeList}`,
							"",
							"The run continues after this turn ends. You will be notified with the full report when it finishes,",
							"so end your turn now rather than polling. Use workflow_status if the user asks about progress.",
						].join("\n"),
					},
				],
				details: {
					runId,
					name: meta.name,
					background: true,
					nodeIds,
					resumed: Boolean(params.resumeRunId),
				},
			};
		},
	});
}
