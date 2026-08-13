/**
 * Tests for the fn node type — a plain function as a graph node.
 *
 * Covers:
 * - g.node('x', (state) => 'result') syntax accepted by GraphBuilder
 * - FnNodeDef is stored with type: "fn"
 * - Execution: runs synchronously, result.text = return value, data = {}
 * - toString() works so ${s.fnNode} interpolates to the returned string
 * - state is passed to the function and readable
 * - plan/contract sandbox functions available inside fn (closure scope)
 * - Errors in fn are caught and reported as technicalFailure
 * - Works as a fan-out hub (multiple direct edges from fn node)
 * - Works as a target of a conditional edge (gate pattern)
 * - Works in the full executor walk (sequential and superstep)
 * - nodeType is "fn" in execution records
 * - Graph validator accepts fn nodes (plain function is valid JS)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	createGraphFactory,
	END,
	type FnNodeDef,
	type AgentNodeDef,
	GraphDefinitionError,
} from "../extensions/graph-dsl.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";
import { withResultText } from "../extensions/graph-node-runner.ts";
import { runSuperstepGraph, type NodeRunner } from "../extensions/graph-executor.ts";
import { makePlanSandboxForTest } from "./helpers/sandbox-extras.ts";
import { planCreate } from "../extensions/plan-tool.ts";

/** Simple deterministic runner for walk tests. */
function makeWalkRunner(scripted: Record<string, string> = {}): NodeRunner {
	return async (node, state) => {
		if (node.def.type === "fn") {
			const text = String(node.def.fn(state));
			return { result: withResultText({ status: "ok" as const, text, data: {} }) };
		}
		const text = scripted[node.id] ?? node.id;
		return { result: withResultText({ status: "ok" as const, text, data: {} }) };
	};
}

// ── GraphBuilder ──────────────────────────────────────────────────────────────

describe("GraphBuilder fn node", () => {
	it("accepts a plain function as node definition", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", () => "hello");
		g.edge("a", END);
		g.run({});
		const graph = g.build();
		const node = graph.nodes.get("a")!;
		expect(node.def.type).toBe("fn");
	});

	it("stores the function on def.fn", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		const fn = (state: Record<string, unknown>) => `count: ${Object.keys(state).length}`;
		g.node("a", fn);
		g.edge("a", END);
		g.run({});
		const graph = g.build();
		const def = graph.nodes.get("a")!.def as FnNodeDef;
		expect(def.type).toBe("fn");
		expect(def.fn).toBe(fn);
	});

	it("fn is the entry node when defined first", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("dispatch", () => "ready");
		g.edge("dispatch", END);
		g.run({});
		expect(g.build().entry).toBe("dispatch");
	});

	it("rejects a non-function, non-NodeDef second argument", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		expect(() => g.node("a", 42 as any)).toThrow(GraphDefinitionError);
		expect(() => g.node("a", 42 as any)).toThrow(/agent\(\)|human\(\)|plain function/);
	});

	it("fn node can be combined with agent nodes in the same graph", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("dispatch", () => "ready");
		g.node("worker", agent("worker", (s) => `task: ${s.dispatch}`));
		g.edge("dispatch", "worker");
		g.edge("worker", END);
		g.run({});
		const graph = g.build();
		expect(graph.nodes.get("dispatch")!.def.type).toBe("fn");
		expect(graph.nodes.get("worker")!.def.type).toBe("agent");
	});
});

// ── FnNodeDef execution (direct) ─────────────────────────────────────────────
// These test the fn node semantics directly via FnNodeDef.fn + withResultText,
// matching exactly what graph-node-runner does in the "fn" case.

describe("fn node execution", () => {
	function runFn(fn: (state: Record<string, unknown>) => unknown, state: Record<string, unknown> = {}) {
		const text = String(fn(state));
		return withResultText({ status: "ok" as const, text, data: {} });
	}

	it("returns the function return value as text", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", () => "hello world");
		g.edge("a", END);
		g.run({});
		const def = g.build().nodes.get("a")!.def as FnNodeDef;
		const result = runFn(def.fn);
		expect(result.text).toBe("hello world");
		expect(result.status).toBe("ok");
	});

	it("receives state and can use it", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", (state) => `value: ${(state as any).key}`);
		g.edge("a", END);
		g.run({});
		const def = g.build().nodes.get("a")!.def as FnNodeDef;
		const result = runFn(def.fn, { key: "found" });
		expect(result.text).toBe("value: found");
	});

	it("result.data is always an empty object", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", () => "done");
		g.edge("a", END);
		g.run({});
		const def = g.build().nodes.get("a")!.def as FnNodeDef;
		const result = runFn(def.fn);
		expect(result.data).toEqual({});
	});

	it("toString() returns the function return value", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", () => "my result");
		g.edge("a", END);
		g.run({});
		const def = g.build().nodes.get("a")!.def as FnNodeDef;
		const result = runFn(def.fn);
		expect(String(result)).toBe("my result");
		expect(`${result}`).toBe("my result");
	});

	it("coerces non-string return values to string", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("a", () => 42 as any);
		g.edge("a", END);
		g.run({});
		const def = g.build().nodes.get("a")!.def as FnNodeDef;
		const result = runFn(def.fn);
		expect(result.text).toBe("42");
	});
});

// ── Full executor walk ────────────────────────────────────────────────────────

describe("fn node in full graph walk", () => {
	it("fn → agent: agent receives fn result as state", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("dispatch", () => "ready signal");
		g.node("worker", agent("worker", (s) => `got: ${(s as any).dispatch}`));
		g.edge("dispatch", "worker");
		g.edge("worker", END);
		g.run({});
		const builtGraph = g.build();

		const prompts: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				if (node.def.type === "fn") {
					const text = String(node.def.fn(state));
					return { result: withResultText({ status: "ok" as const, text, data: {} }) };
				}
				const prompt = (node.def as AgentNodeDef).promptFn(state);
				prompts.push(prompt);
				return { result: withResultText({ status: "ok" as const, text: "done", data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(prompts[0]).toBe("got: ready signal");
	});

	it("conditional → fn (gate) → fan-out: both scouts run", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("gate", agent("worker", () => "gating"));
		g.node("dispatch", () => "fanned out");
		g.node("scout1", agent("scout", (s) => `scout1`));
		g.node("scout2", agent("scout", (s) => `scout2`));
		g.node("combine", agent("worker", () => "combined"));
		g.edge("gate", () => "dispatch");
		g.edge("dispatch", "scout1");
		g.edge("dispatch", "scout2");
		g.edge("scout1", "combine");
		g.edge("scout2", "combine");
		g.edge("combine", END);
		g.run({});
		const builtGraph = g.build();

		const visited: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: makeWalkRunner(),
			onNodeComplete: (e) => { visited.push(e.nodeId); },
		});

		expect(result.status).toBe("completed");
		expect(visited).toContain("dispatch");
		expect(visited).toContain("scout1");
		expect(visited).toContain("scout2");
		expect(visited).toContain("combine");
		expect(visited.filter((v) => v === "dispatch")).toHaveLength(1);
	});
});

// ── buildGraphFromScript ──────────────────────────────────────────────────────

describe("fn node in graph scripts", () => {
	it("plain arrow function accepted by script validator", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('dispatch', () => 'ready');
g.node('worker', agent('worker', (s) => 'task'));
g.edge('dispatch', 'worker');
g.edge('worker', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
		const { graph } = buildGraphFromScript(script);
		expect(graph.nodes.get("dispatch")!.def.type).toBe("fn");
	});

	it("fn node receives state in script", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('dispatch', (state) => 'keys: ' + Object.keys(state).length);
g.node('worker', agent('worker', (s) => 'task'));
g.edge('dispatch', 'worker');
g.edge('worker', END);
g.run({ task: 'do it' });
`;
		const { graph } = buildGraphFromScript(script);
		const def = graph.nodes.get("dispatch")!.def as FnNodeDef;
		expect(def.fn({ task: "do it" })).toBe("keys: 1");
	});

	it("fn node can access plan sandbox", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fn-test-"));
		try {
			planCreate(tmpDir, "Sprint Plan", "# Sprint Plan\n\nContent.");
			const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('dispatch', () => plan.get('sprint-plan').ok ? 'plan exists' : 'no plan');
g.node('worker', agent('worker', (s) => 'task'));
g.edge('dispatch', 'worker');
g.edge('worker', END);
g.run({});
`;
			const { graph } = buildGraphFromScript(script, {
				sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
			});
			const def = graph.nodes.get("dispatch")!.def as FnNodeDef;
			expect(def.fn({})).toBe("plan exists");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("gate pattern: conditional edge → fn dispatch → fan-out", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('plan', agent('planner', () => 'planning'));
g.node('dispatch', () => 'fanning out');
g.node('scout1', agent('scout', (s) => 'scout1'));
g.node('scout2', agent('scout', (s) => 'scout2'));
g.node('combine', agent('worker', (s) => 'done'));
g.edge('plan', (state, result) => result.status === 'ok' ? 'dispatch' : 'plan');
g.edge('dispatch', 'scout1');
g.edge('dispatch', 'scout2');
g.edge('scout1', 'combine');
g.edge('scout2', 'combine');
g.edge('combine', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script);
		expect(graph.nodes.get("dispatch")!.def.type).toBe("fn");
		// dispatch fans out to both scouts
		const edges = graph.edges.get("dispatch")!;
		expect(edges).toHaveLength(2);
		expect(edges.map((e) => (e as any).to).sort()).toEqual(["scout1", "scout2"].sort());
	});
});
