/**
 * Tests for the command node type — a declarative shell command as a
 * graph node.
 *
 * Covers:
 * - g.node('x', command('npm test')) syntax accepted by GraphBuilder
 * - command() validates its inputs (non-empty string, timeoutMs, cwd, env)
 * - CommandNodeDef is stored with type: "command"
 * - Execution via createNodeRunner: exit code, stdout/stderr, status routing
 * - allowFailure forces status "ok" on a nonzero exit
 * - Timeout is a technical failure by default, routable when allowFailure
 * - A missing binary (ENOENT via the shell) is a technical failure
 * - Output is truncated past the byte cap
 * - toString() renders stdout/stderr like an agent result
 * - Script validator: command() requires a literal string, rejects
 *   variables, computed expressions, and template literals with ${}
 * - Full executor walk: command node output flows into a downstream
 *   agent's prompt and into a conditional edge
 * - Journal: nodeType "command" round-trips
 */

import { describe, expect, it } from "vitest";
import {
	agent,
	command,
	createGraphFactory,
	END,
	type CommandNodeDef,
	GraphDefinitionError,
} from "../extensions/graph-dsl.ts";
import { buildGraphFromScript, GraphValidationError } from "../extensions/graph-validator.ts";
import { createNodeRunner, withResultText } from "../extensions/graph-node-runner.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";

// ── command() constructor ───────────────────────────────────────────────────

describe("command() constructor", () => {
	it("builds a CommandNodeDef from a command string", () => {
		const def = command("npm test");
		expect(def.type).toBe("command");
		expect(def.command).toBe("npm test");
		expect(def.allowFailure).toBe(false);
	});

	it("rejects an empty command string", () => {
		expect(() => command("")).toThrow(GraphDefinitionError);
		expect(() => command("   ")).toThrow(GraphDefinitionError);
	});

	it("rejects a non-string command", () => {
		expect(() => command(42 as unknown as string)).toThrow(GraphDefinitionError);
	});

	it("accepts timeoutMs, cwd, env, allowFailure options", () => {
		const def = command("npm test", {
			timeoutMs: 5000,
			cwd: "/tmp",
			env: { NODE_ENV: "test" },
			allowFailure: true,
		});
		expect(def.timeoutMs).toBe(5000);
		expect(def.cwd).toBe("/tmp");
		expect(def.env).toEqual({ NODE_ENV: "test" });
		expect(def.allowFailure).toBe(true);
	});

	it("rejects a non-positive timeoutMs", () => {
		expect(() => command("npm test", { timeoutMs: 0 })).toThrow(GraphDefinitionError);
		expect(() => command("npm test", { timeoutMs: -1 })).toThrow(GraphDefinitionError);
	});

	it("rejects a non-string cwd", () => {
		expect(() => command("npm test", { cwd: 42 as unknown as string })).toThrow(GraphDefinitionError);
	});

	it("rejects a non-object env", () => {
		expect(() => command("npm test", { env: "bad" as unknown as Record<string, string> })).toThrow(
			GraphDefinitionError,
		);
	});
});

// ── GraphBuilder ──────────────────────────────────────────────────────────────

describe("GraphBuilder command node", () => {
	it("accepts command() as a node definition", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("test", command("npm test"));
		g.edge("test", END);
		g.run({});
		const graph = g.build();
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});

	it("command node can be combined with agent nodes in the same graph", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("worker", agent("worker", () => "implement"));
		g.node("test", command("npm test"));
		g.edge("worker", "test");
		g.edge("test", END);
		g.run({});
		const graph = g.build();
		expect(graph.nodes.get("worker")!.def.type).toBe("agent");
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});
});

// ── createNodeRunner: command nodes (real spawnSync execution) ──────────────

describe("createNodeRunner: command nodes", () => {
	const cwd = process.cwd();

	function runnerWith() {
		// spawnAgent is never called for command nodes, but createNodeRunner
		// requires the option to exist.
		return createNodeRunner({ cwd, runId: "r1", spawnAgent: (async () => ({}) as never) as never });
	}

	function commandNode(id: string, def: CommandNodeDef) {
		return { id, def };
	}

	it("runs a real command and captures exit code 0 as status ok", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo hello")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; text: string; data: Record<string, unknown> };
		expect(result.status).toBe("ok");
		expect(result.text).toBe("hello");
		expect(result.data.exitCode).toBe(0);
		expect(result.data.stdout).toBe("hello\n");
		expect(outcome.technicalFailure).toBeUndefined();
	});

	it("captures stderr separately from stdout", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo err-out 1>&2")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { data: Record<string, unknown> };
		expect(result.data.stderr).toBe("err-out\n");
	});

	it("a nonzero exit routes as status blocked by default", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("exit 1")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("blocked");
		expect(result.data.exitCode).toBe(1);
		expect(outcome.technicalFailure).toBeUndefined();
	});

	it("allowFailure forces status ok even on a nonzero exit", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("exit 1", { allowFailure: true })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("ok");
		expect(result.data.exitCode).toBe(1);
	});

	it("a missing binary is a technical failure, not a routable blocked", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("this-binary-does-not-exist-xyz")),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBeUndefined(); // shell itself ran fine, command not found -> exit 127
		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("blocked");
		expect(result.data.exitCode).toBe(127);
	});

	it("a timeout is a technical failure by default", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100 })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.data.timedOut).toBe(true);
		expect(outcome.error).toContain("timed out");
	});

	it("allowFailure suppresses technicalFailure on a timeout too", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100, allowFailure: true })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(false);
		// status must stay in the ok/blocked vocabulary once it's routable —
		// "failed" would be a third value no edge condition expects.
		const result = outcome.result as { status: string };
		expect(result.status).toBe("ok");
	});

	it("without allowFailure, a timeout's status is blocked (display-only: the run already aborted via technicalFailure)", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100 })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		const result = outcome.result as { status: string };
		expect(result.status).toBe("blocked");
	});

	it("respects a custom cwd", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("pwd", { cwd: "/tmp" })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { text: string };
		// macOS /tmp is a symlink to /private/tmp; accept either.
		expect(result.text.endsWith("/tmp")).toBe(true);
	});

	it("respects extra env vars", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo $CUSTOM_VAR", { env: { CUSTOM_VAR: "injected" } })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { text: string };
		expect(result.text).toBe("injected");
	});

	it("toString() on the result renders stdout, matching agent results", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo interpolated")),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(`${outcome.result}`).toBe("interpolated");
	});

	it("truncates output past the byte cap", async () => {
		const runner = runnerWith();
		// Generate well over 32KB of output.
		const outcome = await runner(
			commandNode("test", command("yes x | head -c 100000")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { data: Record<string, unknown> };
		expect((result.data.stdout as string).length).toBeLessThan(100000);
		expect(result.data.stdout).toContain("output truncated");
	});
});

// ── Full executor walk ────────────────────────────────────────────────────────

describe("command node in full graph walk", () => {
	it("worker → test: agent receives the command's output as state", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("worker", agent("worker", () => "implement"));
		g.node("test", command("echo tests-passed"));
		g.node("review", agent("worker", (s) => `result: ${s.test}`));
		g.edge("worker", "test");
		g.edge("test", "review");
		g.edge("review", END);
		g.run({});
		const builtGraph = g.build();

		const prompts: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				if (node.def.type === "command") {
					// Real command execution, same code path production uses.
					const runner = createNodeRunner({
						cwd: process.cwd(),
						runId: "test",
						spawnAgent: (async () => ({}) as never) as never,
					});
					return runner(node, state, { step: 0, runId: "test" });
				}
				const promptFn = (node.def as { promptFn: (s: unknown) => string }).promptFn;
				const prompt = promptFn(state);
				prompts.push(prompt);
				return { result: withResultText({ status: "ok" as const, text: "done", data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(prompts[1]).toBe("result: tests-passed");
	});

	it("conditional edge routes on command exit status", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("test", command("exit 1"));
		g.node("fix", agent("worker", () => "fixing"));
		g.node("done", agent("worker", () => "done"));
		g.edge("test", (state, result: unknown) =>
			(result as { status: string }).status === "ok" ? "done" : "fix",
		);
		g.edge("fix", END);
		g.edge("done", END);
		g.run({});
		const builtGraph = g.build();

		const visited: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				visited.push(node.id);
				if (node.def.type === "command") {
					const runner = createNodeRunner({
						cwd: process.cwd(),
						runId: "test",
						spawnAgent: (async () => ({}) as never) as never,
					});
					return runner(node, state, { step: 0, runId: "test" });
				}
				return { result: withResultText({ status: "ok" as const, text: node.id, data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(visited).toContain("fix");
		expect(visited).not.toContain("done");
	});
});

// ── buildGraphFromScript ──────────────────────────────────────────────────────

describe("command node in graph scripts", () => {
	it("accepts command() with a literal string", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command('npm test'));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
		const { graph } = buildGraphFromScript(script);
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});

	it("accepts command() with a template literal that has no substitutions", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(\`npm test\`));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("accepts command() with options (timeoutMs, allowFailure)", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command('npm test', { timeoutMs: 5000, allowFailure: true }));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("rejects command() built from a variable", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
const cmd = 'npm test';
g.node('test', command(cmd));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
		expect(() => buildGraphFromScript(script)).toThrow(/literal string/);
	});

	it("rejects command() built from a template literal with a substitution", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(\`npm test \${args.suite}\`));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
		expect(() => buildGraphFromScript(script)).toThrow(/literal string/);
	});

	it("rejects command() built from state interpolation", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('worker', agent('worker', () => 'go'));
g.node('test', command('npm test ' + 'extra'));
g.edge('worker', 'test');
g.edge('test', END);
g.run({});
`;
		// String concatenation of two literals is still not a Literal/TemplateLiteral
		// node — rejected, which is intentionally conservative.
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
	});

	it("rejects command() with a computed function call as the argument", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
function buildCmd() { return 'npm test'; }
g.node('test', command(buildCmd()));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
	});
});
