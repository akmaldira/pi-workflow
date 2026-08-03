/**
 * Workflow runtime: deterministic JS parser + sandboxed execution
 *
 * Based on py-dynamic-workflows (Claude-Code-style dynamic workflows).
 * Combines with pi-subagents agent discovery: the `agent()` global resolves
 * named agents from frontmatter and applies their attributes when spawning
 * subagents via the CLI.
 */

import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { AgentConfig } from "./agents.ts";
import { RunJournal, hashString, agentCallKey } from "./journal.ts";
import type { JournalResumeState } from "./journal-types.ts";
import { TechnicalFailureError } from "./failure-classifier.ts";

export interface WorkflowMetaPhase {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
}

export interface WorkflowAgentOptions {
	label?: string;
	phase?: string;
	model?: string;
	/** Override the agent name from the task. If not provided, the agent name from the task is used. */
	agentName?: string;
	/**
	 * Context mode for this agent invocation. "fork" (default) injects a
	 * compaction-style structured summary of the parent session into the
	 * child's system prompt. "fresh" starts with no inherited history.
	 * Falls back to the agent's `defaultContext` frontmatter, then "fork".
	 */
	context?: "fresh" | "fork";
}

export interface WorkflowRunOptions {
	args?: unknown;
	agentRunner?: WorkflowAgentRunner;
	concurrency?: number;
	tokenBudget?: number | null;
	maxAgents?: number;
	maxConcurrent?: number;
	scriptTimeoutMs?: number;
	signal?: AbortSignal;
	cwd?: string;
	journal?: RunJournal;
	journalDir?: string;
	resumeRunId?: string;
	onLog?: (message: string) => void;
	onPhase?: (title: string) => void;
	onAgentStart?: (event: { label: string; phase?: string; prompt: string; agentName: string }) => void;
	onAgentEnd?: (event: { label: string; phase?: string; result: unknown; agentName: string }) => void;
	/**
	 * Called when a subagent hits a *technical* failure (LLM provider error,
	 * process crash — see failure-classifier.ts), just before agent() re-throws
	 * to halt the workflow. Lets the caller (workflow-tool.ts) trigger its own
	 * AbortController so sibling in-flight subagents are SIGTERM'd immediately,
	 * rather than waiting for the throw to unwind through pendingAgentRuns.
	 */
	onTechnicalFailure?: (error: Error) => void;
}

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	durationMs: number;
}

/**
 * Interface for the agent runner that spawns subagents.
 * The workflow runtime calls this to execute agent tasks.
 */
export interface WorkflowAgentRunner {
	/**
	 * Resolve an agent name (parsed from the task prompt or explicit option) to
	 * a discovered AgentConfig. Falls back to a default agent config when the
	 * name does not match a discovered agent.
	 */
	resolveAgent(agentName: string | undefined, cwd?: string): Promise<AgentConfig>;
	/**
	 * Run a subagent task.
	 * @param prompt The task prompt
	 * @param agentConfig The resolved agent config (from pi-subagents discovery)
	 * @param options Additional options
	 * @returns The final text output from the subagent
	 */
	run(
		prompt: string,
		agentConfig: AgentConfig,
		options: {
			label?: string;
			signal?: AbortSignal;
			cwd?: string;
			modelOverride?: string;
			context?: "fresh" | "fork";
		},
	): Promise<string>;
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	spent: number;
	totalTokens: number;
	startTime: number;
	maxAgents?: number;
	scriptTimeoutMs?: number;
	tokenBudget?: number | null;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
	"Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

/**
 * Parse and validate a workflow script, extracting metadata and body.
 * The first statement must be `export const meta = { name, description }`.
 */
export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
	const ast = parse(script, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		ranges: false,
	}) as AnyNode;

	assertDeterministicAst(ast);

	const first = ast.body?.[0] as AnyNode | undefined;
	if (first?.type !== "ExportNamedDeclaration") {
		throw new Error("`export const meta = { name, description }` must be the first statement in the script");
	}

	const declaration = first.declaration as AnyNode | null;
	if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
		throw new Error("meta export must be `export const meta = ...`");
	}
	if (declaration.declarations.length !== 1) {
		throw new Error("meta export must declare only `meta`");
	}

	const declarator = declaration.declarations[0] as AnyNode;
	if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
		throw new Error("meta export must declare `meta`");
	}
	if (!declarator.init) throw new Error("meta must have a literal value");

	const meta = evaluateLiteral(declarator.init, "meta");
	validateMeta(meta);

	return {
		meta,
		body: script.slice(0, first.start) + script.slice(first.end),
	};
}

/**
 * Run a workflow script in a sandboxed VM context.
 * The script can call agent(), parallel(), pipeline(), phase(), and log().
 */
export async function runWorkflow<T = unknown>(
	script: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
	const started = Date.now();
	const { meta, body } = parseWorkflowScript(script);
	const state: RuntimeState = {
		logs: [],
		phases: [],
		agentCount: 0,
		spent: 0,
		totalTokens: 0,
		startTime: started,
		maxAgents: options.maxAgents,
		scriptTimeoutMs: options.scriptTimeoutMs,
		tokenBudget: options.tokenBudget,
	};
	const agentRunner = options.agentRunner;
	const maxConcurrent = Math.max(
		1,
		Math.min(
			options.maxConcurrent ?? options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
			16,
		),
	);
	const limiter = createLimiter(maxConcurrent);
	const pendingAgentRuns = new Set<Promise<unknown>>();

	const log = (message: string) => {
		const text = String(message);
		state.logs.push(text);
		options.onLog?.(text);
	};

	const phase = (title: unknown) => {
		const text = requireString(title, "phase title");
		state.currentPhase = text;
		if (!state.phases.includes(text)) state.phases.push(text);
		options.onPhase?.(text);
	};

	const budget = Object.freeze({
		total: options.tokenBudget ?? null,
		spent: () => state.spent,
		remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
	});

	const throwIfAborted = () => {
		if (options.signal?.aborted) throw new Error("workflow aborted");
	};

	const checkLimits = () => {
		throwIfAborted();
		if (state.maxAgents && state.agentCount >= state.maxAgents) {
			throw new Error(`Max agents limit exceeded (${state.maxAgents})`);
		}
		if (state.scriptTimeoutMs && Date.now() - state.startTime > state.scriptTimeoutMs) {
			throwIfAborted();
			throw new Error(`Script timeout (${state.scriptTimeoutMs}ms)`);
		}
	};

	/**
	 * agent() global: spawn a subagent.
	 *
	 * The prompt can optionally start with an agent name in the format
	 * "agentName: task description". If the agent name matches a discovered
	 * agent, its frontmatter attributes are applied to the subagent execution.
	 */
	const agent = async (prompt: unknown, agentOptions: unknown = {}): Promise<string> => {
		checkLimits();
		if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
		const taskPrompt = requireString(prompt, "agent prompt");
		const normalizedOptions = normalizeAgentOptions(agentOptions);

		// Parse agent name from prompt: "agentName: task" or use explicit agentName option
		let agentName: string | undefined;
		let actualPrompt = taskPrompt;
		const nameMatch = taskPrompt.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/s);
		if (normalizedOptions.agentName) {
			agentName = normalizedOptions.agentName;
			actualPrompt = taskPrompt;
		} else if (nameMatch) {
			agentName = nameMatch[1];
			actualPrompt = nameMatch[2];
		}

		const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
		const requestedLabel = normalizedOptions.label?.trim();
		const run = limiter(async () => {
			if (state.maxAgents && state.agentCount >= state.maxAgents) {
				throw new Error(`Max agents limit reached (${state.maxAgents})`);
			}
			state.agentCount++;
			const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
			options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt, agentName: agentName ?? "default" });
			try {
				throwIfAborted();
				if (!agentRunner) {
					throw new Error("No agent runner configured");
				}
				// Resolve agent config from the runner
				const agentConfig = await agentRunner.resolveAgent(agentName, options.cwd);
				const result = await agentRunner.run(actualPrompt, agentConfig, {
					label,
					signal: options.signal,
					cwd: options.cwd,
					modelOverride: normalizedOptions.model,
					context: normalizedOptions.context,
				});
				throwIfAborted();
				const tokens = estimateTokens(result);
				state.spent += tokens;
				state.totalTokens += tokens;

				// Warn at budget thresholds
				if (state.tokenBudget !== null && state.tokenBudget !== undefined) {
					const used = state.totalTokens;
					const budget_val = state.tokenBudget;
					if (used >= budget_val) {
						log(`⚠ Token budget exceeded: ${used}/${budget_val}`);
					} else if (used >= budget_val * 0.8) {
						log(`⚠ Token budget 80%: ${used}/${budget_val}`);
					}
				}

				options.onAgentEnd?.({ label, phase: assignedPhase, result, agentName: agentName ?? "default" });
				return result;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				// A TechnicalFailureError (LLM provider error, process crash, etc.
				// — see failure-classifier.ts) is deliberately NOT swallowed like
				// ordinary agent-level failures. It re-throws to halt the whole
				// workflow: sibling in-flight subagents are aborted via
				// onTechnicalFailure (which the caller wires to its
				// AbortController), and the error propagates out of the sandboxed
				// script so the workflow run ends with a clear failure reason
				// instead of silently feeding a broken/garbage result to whatever
				// agent() call depended on this one.
				if (error instanceof TechnicalFailureError) {
					log(`agent ${label} hit a technical failure: ${error.message}`);
					options.onAgentEnd?.({ label, phase: assignedPhase, result: null, agentName: agentName ?? "default" });
					options.onTechnicalFailure?.(error);
					throw error;
				}
				log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
				options.onAgentEnd?.({ label, phase: assignedPhase, result: null, agentName: agentName ?? "default" });
				return null;
			}
		});
		pendingAgentRuns.add(run);
		run.then(
			() => pendingAgentRuns.delete(run),
			() => pendingAgentRuns.delete(run),
		);
		return run;
	};

	const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
		checkLimits();
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
		if (thunks.some((thunk) => typeof thunk !== "function")) {
			throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		}
		return Promise.all(
			thunks.map(async (thunk, index) => {
				try {
					return await thunk();
				} catch (error) {
					if (options.signal?.aborted) throw error;
					// Technical failures propagate out of parallel() too, rather
					// than being swallowed into a per-item {error, ok:false} —
					// a sibling item's agent() call already triggered the
					// workflow-level abort via onTechnicalFailure, so this whole
					// parallel() batch (and the workflow) should stop.
					if (error instanceof TechnicalFailureError) throw error;
					log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
					return { error: error instanceof Error ? error.message : String(error), ok: false };
				}
			}),
		);
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
	): Promise<unknown[]> => {
		checkLimits();
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
		if (stages.some((stage) => typeof stage !== "function")) {
			throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
		}
		return Promise.all(
			items.map(async (item, index) => {
				let value: unknown = item;
				for (const stage of stages) {
					try {
						checkLimits();
						value = await stage(value, item, index);
						checkLimits();
					} catch (error) {
						if (options.signal?.aborted) throw error;
						// See parallel() above: technical failures propagate rather
						// than being swallowed into a per-item {error, ok:false}.
						if (error instanceof TechnicalFailureError) throw error;
						log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
						return { error: error instanceof Error ? error.message : String(error), ok: false };
					}
				}
				return value;
			}),
		);
	};

	const context = vm.createContext({
		agent,
		parallel,
		pipeline,
		log,
		phase,
		args: options.args,
		cwd: options.cwd ?? process.cwd(),
		process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
		budget,
		console: {
			log,
			info: log,
			warn: (m: unknown) => log(`[warn] ${String(m)}`),
			error: (m: unknown) => log(`[error] ${String(m)}`),
		},
		JSON,
		Math,
		Array,
		Object,
		String,
		Number,
		Boolean,
		Set,
		Map,
		Promise,
	});

	const wrapped = `(async () => {\n${body}\n})()`;
	const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
	await Promise.allSettled([...pendingAgentRuns]);
	assertStructuredCloneable(result, "workflow result");
	return {
		meta,
		result: result as T,
		logs: state.logs,
		phases: state.phases,
		agentCount: state.agentCount,
		durationMs: Date.now() - started,
	};
}

// --- AST evaluation helpers ---

function evaluateLiteral(node: AnyNode, path: string): unknown {
	switch (node.type) {
		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties as AnyNode[]) {
				if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
				if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
				if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
				const key = propertyKey(prop.key as AnyNode, path);
				if (key === "__proto__" || key === "constructor" || key === "prototype") {
					throw new Error(`reserved key name not allowed in ${path}: ${key}`);
				}
				out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
			}
			return out;
		}
		case "ArrayExpression":
			return (node.elements as Array<AnyNode | null>).map((element, index) => {
				if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
				if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				return evaluateLiteral(element, `${path}[${index}]`);
			});
		case "Literal":
			return node.value;
		case "TemplateLiteral":
			if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
			return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
		case "UnaryExpression":
			if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
				return -node.argument.value;
			}
			throw new Error(`only negative-number unary allowed in ${path}`);
		default:
			throw new Error(`non-literal node type in ${path}: ${node.type}`);
	}
}

function propertyKey(node: AnyNode, path: string): string {
	if (node.type === "Identifier") return node.name;
	if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
		return String(node.value);
	throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
	if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
	const value = meta as WorkflowMeta;
	if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
	if (typeof value.description !== "string" || !value.description.trim())
		throw new Error("meta.description must be a non-empty string");
	if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
		throw new Error("meta.whenToUse must be a string");
	if (value.phases !== undefined) {
		if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
		for (const phase of value.phases) {
			if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
				throw new Error("each meta phase must have a title string");
			}
		}
	}
}

// --- Determinism checks ---

function assertDeterministicAst(node: AnyNode): void {
	if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
		throw new Error(NONDETERMINISM_ERROR);
	}
	for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
	const children: AnyNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) children.push(...value.filter(isAstNode));
		else if (isAstNode(value)) children.push(value);
	}
	return children;
}

function isAstNode(value: unknown): value is AnyNode {
	return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
	return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
	return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
	return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
	if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
		return false;
	}
	return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
	if (!node.computed && node.property?.type === "Identifier") return node.property.name;
	return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
	}
	if (node?.type === "BinaryExpression" && node.operator === "+") {
		const left = staticStringOf(node.left);
		const right = staticStringOf(node.right);
		if (left !== undefined && right !== undefined) return left + right;
	}
	return undefined;
}

// --- Utility functions ---

function createLimiter(limit: number) {
	let active = 0;
	const queue: Array<() => void> = [];
	const next = () => {
		active--;
		queue.shift()?.();
	};
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			next();
		}
	};
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
	if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
	const options = value as WorkflowAgentOptions;
	if (options.context !== undefined && options.context !== "fresh" && options.context !== "fork") {
		throw new TypeError('agent options.context must be "fresh" or "fork"');
	}
	return {
		...options,
		label: optionalString(options.label, "agent label"),
		phase: optionalString(options.phase, "agent phase"),
		model: optionalString(options.model, "agent model"),
		agentName: optionalString(options.agentName, "agent name"),
		context: options.context,
	};
}

function assertStructuredCloneable(value: unknown, name: string): void {
	try {
		structuredClone(value);
	} catch (error) {
		const detail = error instanceof Error ? ` ${error.message}` : "";
		throw new Error(
			`${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
		);
	}
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
	return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
