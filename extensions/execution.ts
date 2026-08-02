/**
 * Core execution logic for running subagents as child pi processes.
 *
 * Based on pi-subagents' execution.ts, adapted for pi-workflow.
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "./child-transcript.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ProtocolOutputLimit,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	type AcceptanceLedger,
	type ResolvedAcceptanceConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "./subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	hasEmptyTerminalAssistantResponse,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "./skills.ts";
import { buildAgentMemoryInjection } from "./agent-memory.ts";
import { evaluateCompletionMutationGuard } from "./completion-guard.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import * as fs from "fs";
import { createJsonlWriter } from "./jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, resolvePiLaunchToolPlan } from "./pi-args.ts";
import { decodeSubagentCapabilityCeiling, resolveCurrentSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV } from "./capability-ceiling.ts";
import { resolveEffectiveThinking } from "./model-info.ts";
import { MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput } from "./structured-output.ts";
import { readChildToolDiagnosticError } from "./tool-availability.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "./single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "./model-fallback.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "./long-running-guard.ts";
import { acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "./acceptance.ts";
import { appendTurnBudgetSystemPrompt, formatTurnBudgetOutput, initialTurnBudgetState, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "./turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "./tool-budget.ts";
import { resolveWatchdogConfig } from "./watchdog/settings.ts";
import { agentDefinitionDigest, launchBindingDigest } from "./launch-contract.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit as ProtocolOutputLimitType } from "./child-protocol.ts";
import {
	acceptChildWatchdogEvent,
	childWatchdogIsActive,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
} from "./watchdog/child-status.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function withRunContext<T extends SingleResult>(result: T, context: RunSyncOptions["context"]): T {
	if (!context) return result;
	result.context = context;
	return result;
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function formatTimeoutMessage(timeoutMs: number): string {
	return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveAttemptTimeout(options: RunSyncOptions): { timeoutMs: number; remainingMs: number; message: string } | undefined {
	if (options.timeoutMs === undefined) return undefined;
	const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
	return {
		timeoutMs: options.timeoutMs,
		remainingMs: Math.max(0, deadlineAt - Date.now()),
		message: formatTimeoutMessage(options.timeoutMs),
	};
}

function buildPendingAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	return {
		status: "pending",
		evidenceStatus: "pending",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		modelCandidates?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const modelArg = applyThinkingSuffix(model, effectiveThinking, options.thinkingOverride !== undefined);
	const resolvedThinking = resolveEffectiveThinking(modelArg, effectiveThinking);
	const watchdogConfig = resolveWatchdogConfig(options.cwd ?? runtimeCwd);
	const childWatchdog = watchdogConfig.ok
		? resolveChildWatchdogConfig({
			config: watchdogConfig.config,
			agent: agent.name,
			runId: options.runId,
			childIndex: options.index ?? 0,
		})
		: undefined;
	const { args, env: sharedEnv, tempDir, toolDiagnosticPath, capabilityAudit } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		thinking: effectiveThinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		parentSessionId: options.parentSessionId,
		structuredOutput: options.structuredOutput,
		toolBudget: options.toolBudget,
		allowZeroToolBudget: options.allowZeroToolBudget,
		childWatchdog,
		waitToolEnabled: options.waitToolEnabled,
		capabilityCeiling: options.capabilityCeiling,
	});

	const effectiveSystemPrompt = appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget);
	const toolPlan = resolvePiLaunchToolPlan({
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		structuredOutput: Boolean(options.structuredOutput),
		capabilityCeiling: options.capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
	});
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agent),
		task: shared.originalTask ?? task,
		...(modelArg ? { model: modelArg } : {}),
		modelCandidates: shared.modelCandidates,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: shared.resolvedSkillNames ?? [],
		tools: toolPlan.effectiveToolAllowlist,
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		outputMode: options.outputMode ?? "inline",
		...(options.structuredOutput ? { structuredOutputSchema: options.structuredOutput.schema } : {}),
	});
	const result: SingleResult = withRunContext({
		agent: agent.name,
		task: shared.originalTask ?? task,
		...(options.agentContract ? { agentContract: options.agentContract } : {}),
		launchContractDigest,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
		...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		...(capabilityAudit ? { capabilityAudit } : {}),
	}, options.context);
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: any[] = [];
	let pendingControlEvents: any[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: any) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const attemptTimeout = resolveAttemptTimeout(options);
	if (attemptTimeout?.remainingMs === 0) {
		cleanupTempDir(tempDir);
		result.exitCode = 1;
		result.timedOut = true;
		result.error = attemptTimeout.message;
		result.finalOutput = attemptTimeout.message;
		return result;
	}

	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };

	const spawnSpec = getPiSpawnCommand(args);
	const proc = spawn(spawnSpec.command, spawnSpec.args, {
		cwd: options.cwd ?? runtimeCwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: spawnEnv,
	});

	fs.appendFileSync("/tmp/subagent.log", `CMD: ${spawnSpec.command} ${spawnSpec.args.join(" ")}\n`);
	proc.stderr?.on("data", (data) => {
		fs.appendFileSync("/tmp/subagent.log", `STDERR: ${data}\n`);
	});

	const stdoutReader = createBoundedLineReader({
		stream: "stdout",
		onLine: (line) => {
			try {
				const event = JSON.parse(line);
				options.onEvent?.(event);
				if (event.type === "message_end" || event.type === "tool_result_end") {
					result.messages?.push(event.message);
					if (event.message?.role === "assistant") {
						appendRecentOutput(progress, extractTextFromContent(event.message));
					}
				}
				if (event.type === "error") {
					result.errorMessage = event.error || event.message;
					result.stopReason = "error";
				}
				if (event.type === "turn_end") {
					result.usage = event.message?.usage || result.usage;
					result.stopReason = event.message?.stopReason || "end";
					if (event.turnCount !== undefined) progress.turnCount = event.turnCount;
				}
				if (event.type === "agent_end") {
					if (event.messages && event.messages.length > 0) {
						// Ensure we capture all messages at the end in case we missed some
						result.messages = event.messages;
					}
				}
				if (event.type === "abort") {
					result.stopReason = "aborted";
				}
				if (event.type === "tool_execution_start") {
					progress.toolCount++;
					progress.recentTools.push({
						tool: event.toolName || event.tool || "unknown",
						args: extractToolArgsPreview(event),
						endMs: Date.now(),
					});
					progress.recentTools = progress.recentTools.slice(-20);
				}
				if (event.type === "agent_end" || event.type === "agent_settled") {
					const action = projectChildLifecycle(event);
					if (action === "start-drain") {
						// Start draining output
					}
				}
				shared.transcriptWriter?.append({ type: "child_event", event, ts: Date.now() });
				shared.jsonlPath && createJsonlWriter(shared.jsonlPath).write({ type: "child_event", event, ts: Date.now() });
			} catch {
				// Non-JSON lines are ignored
			}
		},
		onLimit: (limit: ProtocolOutputLimitType) => {
			result.protocolError = limit;
			result.error = formatProtocolOutputLimit(limit);
		},
	});

	const stderrReader = createBoundedByteTail();
	proc.stdout.on("data", (chunk) => stdoutReader.push(chunk));
	proc.stderr.on("data", (chunk) => {
		stderrReader.push(chunk);
	});

	proc.stdout.on("end", () => stdoutReader.end());

	const abortHandler = () => {
		trySignalChild(proc, "SIGTERM");
	};
	options.signal?.addEventListener("abort", abortHandler);
	options.interruptSignal?.addEventListener("abort", abortHandler);

	const timeoutHandle = attemptTimeout
		? setTimeout(() => {
			trySignalChild(proc, "SIGKILL");
		}, attemptTimeout.remainingMs)
		: undefined;

	let exitCode: number | null = null;
	let exitSignal: string | null = null;

	try {
		exitCode = await new Promise<number | null>((resolve) => {
			proc.on("close", (code, signal) => {
				resolve(code);
				exitSignal = signal;
			});
			proc.on("error", () => {
				resolve(1);
			});
		});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		options.signal?.removeEventListener("abort", abortHandler);
		options.interruptSignal?.removeEventListener("abort", abortHandler);
	}

	progress.status = "completed";
	progress.durationMs = Date.now() - startTime;
	result.exitCode = exitCode ?? 1;

	if (options.signal?.aborted) {
		result.interrupted = true;
		result.exitCode = 130;
	}

	if (result.stopReason === "aborted") {
		result.exitCode = 130;
	}

	// Parse structured output
	if (options.structuredOutput) {
		const structured = await readStructuredOutput(options.structuredOutput);
		if (structured.error) {
			result.structuredOutputFailed = true;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	// Resolve single output
	if (options.outputPath) {
		const resolved = resolveSingleOutput(
			options.outputPath,
			getFinalOutput(result.messages ?? []),
			shared.outputSnapshot,
		);
		result.finalOutput = resolved.fullOutput;
		if (resolved.savedPath) {
			result.savedOutputPath = resolved.savedPath;
			result.outputReference = formatSavedOutputReference(resolved.savedPath, resolved.fullOutput);
		}
		if (resolved.saveError) {
			result.outputSaveError = resolved.saveError;
		}
	} else {
		result.finalOutput = getFinalOutput(result.messages ?? []);
	}

	// Truncate output
	const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
	const truncated = truncateOutput(result.finalOutput || "", { bytes: maxOutput.bytes, lines: maxOutput.lines }, shared.artifactPaths?.outputPath);
	result.finalOutput = truncated.text;
	if (truncated.truncated) {
		result.truncation = {
			text: truncated.text,
			truncated: true,
			originalBytes: truncated.originalBytes,
			originalLines: truncated.originalLines,
			artifactPath: truncated.artifactPath,
		};
	}

	// Evaluate acceptance
	if (options.acceptance) {
		const effective = resolveEffectiveAcceptance({
			agentName: agent.name,
			acceptance: options.acceptance,
			acceptanceContext: options.acceptanceContext,
		});
		const acceptanceLedger = await evaluateAcceptance({
			acceptance: effective,
			output: result.finalOutput || "",
			cwd: options.cwd ?? runtimeCwd,
		});
		result.acceptance = acceptanceLedger;
		if (acceptanceLedger.status === "rejected") {
			result.error = acceptanceFailureMessage(acceptanceLedger);
		}
	}

	// Write artifacts
	if (shared.artifactPaths) {
		try {
			writeArtifact(shared.artifactPaths.inputPath, `Task: ${task}\n\nAgent: ${agent.name}`);
			writeArtifact(shared.artifactPaths.outputPath, result.finalOutput || "");
			writeMetadata(shared.artifactPaths.metadataPath, {
				agent: agent.name,
				task,
				exitCode: result.exitCode,
				model: result.model,
				turns: result.usage.turns,
				tokens: result.usage,
				acceptance: result.acceptance,
			});
		} catch {
			// Artifact writing is best-effort
		}
	}

	shared.transcriptWriter?.close();

	return result;
}

export async function runSingleAgent(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const modelCandidates = buildModelCandidates(
		agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);

	const resolvedSkillNames = options.skills ?? agent.skills;
	const skillsWarning = resolvedSkillNames ? undefined : undefined;

	const artifactPaths = options.artifactConfig?.enabled
		? getArtifactPaths(
			options.artifactsDir ?? path.join(runtimeCwd, ".pi-subagents", "artifacts"),
			options.runId,
			agent.name,
			options.index,
		)
		: undefined;

	const transcriptWriter = artifactPaths ? createChildTranscriptWriter({ transcriptPath: artifactPaths.transcriptPath }) : undefined;
	const jsonlWriter = artifactPaths ? createJsonlWriter(artifactPaths.jsonlPath) : undefined;

	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);

	const systemPrompt = await buildSystemPrompt(agent, runtimeCwd, options);

	const shared = {
		sessionEnabled: Boolean(options.sessionFile || options.sessionDir),
		systemPrompt,
		resolvedSkillNames,
		modelCandidates,
		skillsWarning,
		jsonlPath: artifactPaths?.jsonlPath,
		artifactPaths,
		transcriptWriter,
		attemptNotes: [] as string[],
		outputSnapshot,
		originalTask: task,
	};

	let lastResult: SingleResult | undefined;
	let currentModels = [...modelCandidates];
	let attempt = 0;

	while (true) {
		const currentModel = currentModels[attempt] ?? currentModels[currentModels.length - 1];
		if (!currentModel && attempt > 0) {
			// No more models to try
			break;
		}

		try {
			lastResult = await runSingleAttempt(
				runtimeCwd,
				agent,
				task,
				currentModel,
				options,
				shared,
			);
		} catch (error) {
			lastResult = {
				agent: agent.name,
				task,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				model: currentModel,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		if (lastResult.exitCode === 0) {
			break;
		}

		// Check for retryable model failure
		const errorText = lastResult.error || lastResult.stopReason || "";
		if (isRetryableModelFailure(errorText) && attempt + 1 < currentModels.length) {
			attempt++;
			shared.attemptNotes.push(formatModelAttemptNote(
				{ model: currentModel ?? "unknown", success: false, error: errorText, exitCode: lastResult.exitCode },
				currentModels[attempt],
			));
			continue;
		}

		break;
	}

	jsonlWriter?.close();

	return lastResult ?? {
		agent: agent.name,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "No model candidates available",
	};
}

async function buildSystemPrompt(agent: AgentConfig, cwd: string, options: RunSyncOptions): Promise<string> {
	let prompt = agent.systemPrompt || "";

	// Inject acceptance prompt
	if (options.acceptance) {
		const effective = resolveEffectiveAcceptance({
			agentName: agent.name,
			acceptance: options.acceptance,
			acceptanceContext: options.acceptanceContext,
		});
		prompt = appendSystemPrompt(prompt, formatAcceptancePrompt(effective));
	}

	// Inject memory
	if (agent.memory) {
		const memoryInjection = await buildAgentMemoryInjection(agent.memory, cwd);
		if (memoryInjection) {
			prompt = appendSystemPrompt(prompt, memoryInjection);
		}
	}

	// Inject skills
	if (options.skills && options.skills.length > 0) {
		const skillInjection = await buildSkillInjection(options.skills, cwd);
		if (skillInjection) {
			prompt = appendSystemPrompt(prompt, skillInjection);
		}
	}

	// Inject completion guard
	if (agent.completionGuard) {
		prompt = appendSystemPrompt(prompt, "## Completion guard\nOnly declare completion when you have fully addressed the task. Do not stop prematurely.");
	}

	return prompt;
}

function appendSystemPrompt(base: string, addition: string): string {
	return base ? `${base}\n\n${addition}` : addition;
}
