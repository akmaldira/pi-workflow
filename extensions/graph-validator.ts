/**
 * Graph script validation and sandboxed evaluation.
 *
 * A graph script is code written by a model, so it is validated before it
 * runs and then executed with almost nothing reachable. Three layers, in
 * order:
 *
 *   1. AST validation — reject forbidden syntax before evaluating anything.
 *   2. Sandbox        — evaluate in a vm context exposing only the graph API.
 *   3. Structural     — validate the built graph (GraphBuilder.validate).
 *
 * The layers are deliberately redundant. AST validation is the readable,
 * fail-fast layer that produces good error messages; the sandbox is the one
 * that actually contains a script the AST checks failed to anticipate.
 * Neither is trusted to be sufficient alone.
 */

import * as vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import {
	type BuiltGraph,
	END,
	GraphBuilder,
	GraphDefinitionError,
	agent,
	command,
	createGraphFactory,
	human,
} from "./graph-dsl.ts";
import { extractConditionalTargets } from "./graph-edge-targets.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn AST nodes have arbitrary properties
type AnyNode = Node & { [key: string]: any; start: number; end: number };

export interface GraphMeta {
	name: string;
	description: string;
	whenToUse?: string;
}

export interface GraphScriptResult {
	meta: GraphMeta;
	graph: BuiltGraph;
}

export class GraphValidationError extends Error {
	readonly problems: string[];

	constructor(message: string, problems: string[] = []) {
		super(message);
		this.name = "GraphValidationError";
		this.problems = problems;
	}
}

/**
 * Globals a graph script may reference.
 *
 * Everything else is a validation error. This is an allowlist rather than a
 * denylist on purpose: a denylist silently admits whatever it forgot, and
 * the set of dangerous globals in Node is both large and version-dependent.
 */
const ALLOWED_GLOBALS = new Set([
	"graph",
	"agent",
	"human",
	"command",
	"END",
	"args",
	"meta",
	// Prompt construction from structured results is common enough that
	// omitting JSON would push authors toward manual string building. Inside
	// the vm context this resolves to the context's own JSON, not the host's.
	"JSON",
	// Language intrinsics with no capability attached. These are NOT injected
	// into the sandbox: they resolve to the vm context's realm-local copies,
	// so using them cannot reach host state.
	"undefined",
	"NaN",
	"Infinity",
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"Error",
	"Math",
	"isNaN",
	"parseInt",
	"parseFloat",
]);

/**
 * Identifiers that are always rejected, even shadowed by a local binding.
 *
 * A local named `require` is harmless in itself, but allowing it means a
 * reviewer reading the script cannot tell at a glance whether a call is the
 * real thing. Rejecting the name outright keeps that judgement cheap.
 */
const FORBIDDEN_NAMES = new Set([
	"require",
	"process",
	"globalThis",
	"global",
	"eval",
	"Function",
	"fetch",
	"import",
	"module",
	"exports",
	"__dirname",
	"__filename",
	"Buffer",
	"setTimeout",
	"setInterval",
	"setImmediate",
	"queueMicrotask",
	"Reflect",
	"Proxy",
	"WebAssembly",
	"SharedArrayBuffer",
	"Atomics",
	"XMLHttpRequest",
	"child_process",
]);

/**
 * Property names that lead from an ordinary value back to a function
 * constructor, and from there to arbitrary code.
 *
 * `({}).constructor.constructor("...")` is the canonical vm escape. Code
 * generation is disabled on the context and the intrinsics are realm-local,
 * so this is the third independent barrier rather than the only one — but a
 * graph script has no legitimate reason to walk a prototype chain, so the
 * shape is rejected outright and the failure is legible.
 */
const FORBIDDEN_PROPERTIES = new Set([
	"constructor",
	"__proto__",
	"prototype",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	// Reflection over the object graph. With realm-local intrinsics these
	// can no longer reach host state or code execution, so this is hygiene
	// rather than containment: routing logic has no use for them, and
	// allowing them would leave a prototype-manipulation surface inside the
	// definition realm for no benefit.
	"getPrototypeOf",
	"setPrototypeOf",
	"defineProperty",
	"defineProperties",
	"getOwnPropertyDescriptor",
	"getOwnPropertyDescriptors",
]);

const NONDETERMINISM_ERROR =
	"Graph scripts must be deterministic: Date.now(), Math.random(), and new Date() are unavailable. Routing decisions must depend only on agent results, or a rerun of the same graph could take a different path.";

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

function propertyNameOf(node: AnyNode): string | null {
	if (node.computed) {
		return node.property?.type === "Literal" ? String(node.property.value) : null;
	}
	return node.property?.type === "Identifier" ? node.property.name : null;
}

function isMemberCall(node: AnyNode, objectName: string, propertyName: string): boolean {
	if (node.type !== "CallExpression") return false;
	const callee = node.callee as AnyNode | undefined;
	if (callee?.type !== "MemberExpression") return false;
	if (callee.object?.type !== "Identifier" || callee.object.name !== objectName) return false;
	return propertyNameOf(callee) === propertyName;
}

/**
 * Collects locally-bound names so that references to them are not mistaken
 * for forbidden globals.
 *
 * Intentionally over-collects: it walks the whole tree rather than modelling
 * lexical scope. The cost is that a name bound anywhere is treated as bound
 * everywhere, which can only make validation more permissive for names that
 * were already going to be locals. Names in FORBIDDEN_NAMES are checked
 * before this set is consulted, so over-collection cannot open a hole.
 */
function collectLocalBindings(root: AnyNode): Set<string> {
	const locals = new Set<string>();

	const addPattern = (pattern: AnyNode | undefined): void => {
		if (!pattern) return;
		switch (pattern.type) {
			case "Identifier":
				locals.add(pattern.name);
				break;
			case "ObjectPattern":
				for (const prop of pattern.properties ?? []) {
					if (prop.type === "RestElement") addPattern(prop.argument);
					else addPattern(prop.value);
				}
				break;
			case "ArrayPattern":
				for (const element of pattern.elements ?? []) addPattern(element);
				break;
			case "AssignmentPattern":
				addPattern(pattern.left);
				break;
			case "RestElement":
				addPattern(pattern.argument);
				break;
		}
	};

	const walk = (node: AnyNode): void => {
		switch (node.type) {
			case "VariableDeclarator":
				addPattern(node.id);
				break;
			case "FunctionDeclaration":
			case "FunctionExpression":
			case "ArrowFunctionExpression":
				if (node.id?.type === "Identifier") locals.add(node.id.name);
				for (const param of node.params ?? []) addPattern(param);
				break;
			case "ClassDeclaration":
			case "ClassExpression":
				if (node.id?.type === "Identifier") locals.add(node.id.name);
				break;
			case "CatchClause":
				addPattern(node.param);
				break;
		}
		for (const child of astChildren(node)) walk(child);
	};

	walk(root);
	return locals;
}

/**
 * True when this identifier node is a property name rather than a variable
 * reference. `obj.process` and `{ process: 1 }` must not be treated as
 * touching the global `process`.
 */
function isNonReferencePosition(node: AnyNode, parent: AnyNode | null): boolean {
	if (!parent) return false;

	if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
	if (parent.type === "Property" && parent.key === node && !parent.computed) return true;
	if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) return true;
	if (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) return true;

	return false;
}

export interface AstValidationOptions {
	/** Extra globals to permit. Used by tests; not exposed to scripts. */
	extraGlobals?: string[];
}

/**
 * Validates a parsed graph script, returning every problem found.
 *
 * Returns a list rather than throwing on the first problem so a model
 * revising a rejected script sees all of them at once.
 */
export function validateGraphAst(ast: AnyNode, options: AstValidationOptions = {}): string[] {
	const problems: string[] = [];
	const allowed = new Set([...ALLOWED_GLOBALS, ...(options.extraGlobals ?? [])]);
	const locals = collectLocalBindings(ast);

	const walk = (node: AnyNode, parent: AnyNode | null): void => {
		switch (node.type) {
			case "ImportDeclaration":
			case "ImportExpression":
				problems.push(
					"import is not allowed in a graph script. Everything a graph needs is already provided: graph, agent, human, command, END, args.",
				);
				break;
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				problems.push("Only `export const meta = { ... }` may be exported from a graph script.");
				break;
			case "WithStatement":
				problems.push("`with` is not allowed in a graph script.");
				break;
			case "MetaProperty":
				problems.push("`import.meta` is not allowed in a graph script.");
				break;
			case "ThisExpression":
				// At the top level of a vm script `this` is the sandbox global,
				// which turns it into a way to enumerate and index into globals
				// by computed name, sidestepping identifier checks.
				problems.push(
					"`this` is not available in a graph script. Node prompts and edge conditions receive everything they need as parameters.",
				);
				break;
		}

		if (node.type === "MemberExpression") {
			const propertyName = propertyNameOf(node);
			if (propertyName !== null && FORBIDDEN_PROPERTIES.has(propertyName)) {
				problems.push(
					`Accessing "${propertyName}" is not allowed in a graph script. Graph scripts describe routing over agent results; they do not need prototype access.`,
				);
			}
			// A computed access whose key is not a literal could resolve to any
			// of the above at runtime, so the static check cannot clear it.
			if (node.computed && node.property?.type !== "Literal") {
				const isSimpleIndex =
					node.property?.type === "Identifier" || node.property?.type === "BinaryExpression";
				if (!isSimpleIndex) {
					problems.push(
						"Computed property access with a dynamic key is not allowed in a graph script.",
					);
				}
			}
		}

		if (isMemberCall(node, "Date", "now") || isMemberCall(node, "Math", "random")) {
			problems.push(NONDETERMINISM_ERROR);
		}
		if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date") {
			problems.push(NONDETERMINISM_ERROR);
		}

		// command()'s whole safety story is that the command a human reviews in
		// the script is the command that runs — no runtime computation between
		// them. Enforced here, at parse time, rather than left to convention: an
		// argument built from anything other than a plain string literal (or a
		// template literal with no ${} substitutions) is rejected outright.
		if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "command") {
			const firstArg = node.arguments?.[0] as AnyNode | undefined;
			const isStaticString =
				firstArg?.type === "Literal" && typeof firstArg.value === "string"
					? true
					: firstArg?.type === "TemplateLiteral" && (firstArg.expressions?.length ?? 0) === 0;
			if (!isStaticString) {
				problems.push(
					"command() requires a literal string as its first argument — not a variable, template with ${} substitutions, or any computed expression. A human reviewing the script must be able to see the exact command that will run.",
				);
			}
		}

		if (node.type === "Identifier" && !isNonReferencePosition(node, parent)) {
			const name = node.name;
			if (FORBIDDEN_NAMES.has(name)) {
				problems.push(
					`"${name}" is not available in a graph script. Graph scripts describe routing only; they cannot read files, run commands, or reach the network.`,
				);
			} else if (!allowed.has(name) && !locals.has(name)) {
				problems.push(
					`"${name}" is not available in a graph script. Available globals: ${[...allowed].sort().join(", ")}.`,
				);
			}
		}

		for (const child of astChildren(node)) walk(child, node);
	};

	walk(ast, null);

	return [...new Set(problems)];
}

function literalValue(node: AnyNode | undefined): unknown {
	if (!node) return undefined;
	if (node.type === "Literal") return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis.map((q: AnyNode) => q.value.cooked).join("");
	}
	return undefined;
}

/**
 * Extracts `export const meta = { ... }`, which must be the first statement.
 *
 * Read from the AST rather than from the sandbox result so that a script
 * rejected by validation still yields a name for logs and error messages.
 */
export function extractGraphMeta(ast: AnyNode): GraphMeta {
	const first = ast.body?.[0] as AnyNode | undefined;

	if (first?.type !== "ExportNamedDeclaration") {
		throw new GraphValidationError(
			"`export const meta = { name, description }` must be the first statement in a graph script.",
		);
	}

	const declaration = first.declaration as AnyNode | null;
	if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
		throw new GraphValidationError("meta must be declared with `export const meta = { ... }`.");
	}
	if (declaration.declarations.length !== 1) {
		throw new GraphValidationError("The meta export must declare only `meta`.");
	}

	const declarator = declaration.declarations[0] as AnyNode;
	if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
		throw new GraphValidationError("The first export must be named `meta`.");
	}
	if (declarator.init?.type !== "ObjectExpression") {
		throw new GraphValidationError("meta must be an object literal.");
	}

	const values: Record<string, unknown> = {};
	for (const property of declarator.init.properties ?? []) {
		if (property.type !== "Property" || property.computed) continue;
		const key =
			property.key?.type === "Identifier"
				? property.key.name
				: property.key?.type === "Literal"
					? String(property.key.value)
					: null;
		if (key) values[key] = literalValue(property.value);
	}

	const name = values.name;
	const description = values.description;

	if (typeof name !== "string" || name.trim().length === 0) {
		throw new GraphValidationError("meta.name must be a non-empty string literal.");
	}
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new GraphValidationError("meta.description must be a non-empty string literal.");
	}

	return {
		name: name.trim(),
		description: description.trim(),
		whenToUse: typeof values.whenToUse === "string" ? values.whenToUse.trim() : undefined,
	};
}

export interface EvaluateGraphOptions {
	/** Value bound to `args` inside the script. */
	args?: unknown;
	/** Wall-clock cap for evaluating the definition. Default 1000ms. */
	timeoutMs?: number;
	/**
	 * Extra names injected into the sandbox and permitted by the AST checker.
	 * Values must be plain synchronous objects/functions — no Promises, no
	 * host-realm references that could bridge back to host state.
	 *
	 * Each key becomes a top-level global inside the script. Property access
	 * on the object (e.g. `plan.get(...)`) works without any extra config —
	 * only the root identifier needs to be listed here.
	 */
	sandboxExtras?: Record<string, unknown>;
}

/**
 * Parses, validates, and evaluates a graph script.
 *
 * Evaluation only builds a description; no agent runs here. The timeout
 * bounds definition-time work such as an accidental infinite loop, and is
 * unrelated to how long the graph later takes to execute.
 */
export function buildGraphFromScript(
	script: string,
	options: EvaluateGraphOptions = {},
): GraphScriptResult {
	if (typeof script !== "string" || script.trim().length === 0) {
		throw new GraphValidationError("Graph script is empty.");
	}

	let ast: AnyNode;
	try {
		ast = parse(script, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: false,
			allowReturnOutsideFunction: false,
		}) as AnyNode;
	} catch (error) {
		throw new GraphValidationError(
			`Graph script is not valid JavaScript: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const meta = extractGraphMeta(ast);

	const problems = validateGraphAst(ast, {
		extraGlobals: options.sandboxExtras ? Object.keys(options.sandboxExtras) : [],
	});
	if (problems.length > 0) {
		throw new GraphValidationError(
			`Graph script failed validation:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
			problems,
		);
	}

	const { graph, getBuilder } = createGraphFactory();

	// Only these names are injected. Standard intrinsics (Object, Array,
	// JSON, ...) are deliberately NOT passed in: a vm context has its own
	// realm-local copies, and injecting the host's would hand the script a
	// bridge back to the host realm. Host `Object.constructor` is the host
	// `Function`, which is not subject to this context's codeGeneration
	// restriction, and host `Object.prototype` is the one this process runs
	// on — so a script could both compile code and pollute our own
	// prototypes. Leaving them out keeps every intrinsic realm-local.
	const sandbox: Record<string, unknown> = {
		graph,
		agent,
		human,
		command,
		END,
		...options.sandboxExtras,
	};

	const context = vm.createContext(sandbox, {
		codeGeneration: { strings: false, wasm: false },
	});

	// args originates in the host realm, so it is rebuilt inside the context
	// rather than handed over by reference: otherwise args.constructor would
	// be another bridge to host Function, and a graph script could mutate
	// caller state. A JSON round-trip performed by the context's own JSON
	// yields plain, realm-local data.
	if (options.args !== undefined) {
		let serialisedArgs: string;
		try {
			serialisedArgs = JSON.stringify(options.args ?? null);
		} catch {
			throw new GraphValidationError("Graph args must be JSON-serialisable.");
		}
		try {
			sandbox.args = new vm.Script(`(${serialisedArgs || "null"})`, {
				filename: "graph-args.js",
			}).runInContext(context, { timeout: 1000 });
		} catch (error) {
			throw new GraphValidationError(
				`Graph args could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// The meta export is validated from the AST; strip it so the body can be
	// evaluated as a plain script rather than a module.
	const metaStatement = ast.body[0] as AnyNode;
	const body = `${" ".repeat(metaStatement.end)}${script.slice(metaStatement.end)}`;

	try {
		new vm.Script(body, { filename: `${meta.name}.graph.js` }).runInContext(context, {
			timeout: options.timeoutMs ?? 1000,
			breakOnSigint: true,
		});
	} catch (error) {
		if (error instanceof GraphDefinitionError) {
			throw new GraphValidationError(error.message);
		}
		throw new GraphValidationError(
			`Graph script failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const builder = getBuilder();
	if (!builder) {
		throw new GraphValidationError(
			"Graph script never called graph(). A graph script must create a graph, define nodes and edges, and call g.run().",
		);
	}
	if (!(builder instanceof GraphBuilder)) {
		throw new GraphValidationError("graph() did not produce a valid graph builder.");
	}

	let built: BuiltGraph;
	try {
		built = builder.build();
	} catch (error) {
		if (error instanceof GraphDefinitionError) {
			throw new GraphValidationError(error.message);
		}
		throw error;
	}

	// Recover what each conditional edge can route to. This has to happen here,
	// from the AST: once the sandbox has run, an edge is a closure with no
	// readable target. The executor needs it to tell "nothing left to wait for"
	// apart from "actually routed here".
	built.conditionalTargets = extractConditionalTargets(ast, new Set(built.nodes.keys()));

	return { meta, graph: built };
}
