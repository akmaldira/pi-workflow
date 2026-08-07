/**
 * Conditional routing: what works, and the one case that does not.
 *
 * SCOPE: script-built graphs are FIXED — conditional edge targets are recovered
 * from the AST, so a conditional fan-in join runs exactly once. What remains is
 * graphs built programmatically via GraphBuilder (tests and direct API use),
 * which have no AST to analyse and fall back to a conservative reach estimate
 * that cannot tell which node a conditional edge will pick.
 *
 * The workflow tool always builds from a script, so the user-facing path is
 * correct. This file pins the remaining gap in the programmatic path.
 *
 * These tests document behaviour that does NOT match the design in
 * docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md. They are written as assertions of
 * what currently happens, not of what should happen, so the gap stays visible
 * and a future fix has a ready-made regression test: when the limitation is
 * fixed, these tests fail loudly and should be rewritten to assert the
 * correct behaviour instead.
 */

import { describe, expect, it } from "vitest";
import { agent, END, GraphBuilder } from "../extensions/graph-dsl.ts";
import type { BuiltGraph } from "../extensions/graph-dsl.ts";
import type { NodeRunner } from "../extensions/graph-executor.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

/**
 * planner ──→ fast ─────────────→ join      (direct edge into join)
 *         └─→ slow ──→ mid ──(?)─→ join     (CONDITIONAL edge into join)
 *
 * `join` genuinely has two incoming edges, but only one is direct.
 */
function conditionalJoinGraph(): BuiltGraph {
	const g = new GraphBuilder();
	g.node("planner", agent("planner", () => "p"));
	g.node("fast", agent("w", () => "fast"));
	g.node("slow", agent("w", () => "slow"));
	g.node("mid", agent("w", () => "mid"));
	g.node("join", agent("w", (s) => `join(${s.fast},${s.mid})`));
	g.edge("planner", "fast");
	g.edge("planner", "slow");
	g.edge("fast", "join"); // direct
	g.edge("slow", "mid");
	g.edge("mid", () => "join"); // conditional
	g.edge("join", END);
	g.run();
	return g.build();
}

describe("KNOWN LIMITATION: conditional fan-in on programmatic graphs", () => {
	/**
	 * Why this happens: readiness is driven by a static in-degree count, and a
	 * conditional edge carries only an opaque function — it declares no target,
	 * so it cannot be counted. `join` is therefore credited with in-degree 1
	 * instead of 2 and fires as soon as `fast` lands.
	 *
	 * Why it is not simply "count conditional edges too": the target is unknown,
	 * so counting one forces a guess about which nodes it might claim. Guessing
	 * wide deadlocks the graph (a claim is only released when the claiming node
	 * runs, so claiming an upstream node blocks the node that must run first);
	 * guessing narrow reproduces this bug. A correct fix needs a different
	 * mechanism than static counting — most likely deferring a join while any
	 * predecessor that could still reach it remains unsettled.
	 *
	 * Impact: a graph whose fan-in branches all arrive via DIRECT edges — which
	 * is every documented pattern, including the escalation loop and the
	 * parallel-audit example — is unaffected and does honour AND fan-in.
	 */
	it("runs the join twice: once on partial data, once when the rest arrives", async () => {
		const seen: Record<string, unknown>[] = [];
		const runner: NodeRunner = async (node, state) => {
			if (node.id === "join") seen.push({ ...state });
			return { result: node.id };
		};

		const result = await runSuperstepGraph(conditionalJoinGraph(), {
			runId: "known-limit",
			runNode: runner,
		});

		expect(result.status).toBe("completed");

		// DESIGN SAYS: exactly 1. ACTUAL: 2 — the first is on partial data.
		const joinRuns = result.history.filter((h) => h.nodeId === "join");
		expect(joinRuns).toHaveLength(2);

		// The first run fired before `mid` existed in state.
		expect(seen[0]).not.toHaveProperty("mid");
		// The second run did see it, so the final result is correct — the flaw
		// is the wasted early run, not a wrong answer.
		expect(seen[1]).toHaveProperty("mid");
	});

	it("still honours AND fan-in when every in-edge is direct", async () => {
		// The same shape with a direct edge from mid behaves correctly, which
		// isolates the cause to the conditional edge rather than to depth.
		const g = new GraphBuilder();
		g.node("planner", agent("planner", () => "p"));
		g.node("fast", agent("w", () => "fast"));
		g.node("slow", agent("w", () => "slow"));
		g.node("mid", agent("w", () => "mid"));
		g.node("join", agent("w", () => "join"));
		g.edge("planner", "fast");
		g.edge("planner", "slow");
		g.edge("fast", "join");
		g.edge("slow", "mid");
		g.edge("mid", "join"); // direct, not conditional
		g.edge("join", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "direct-join",
			runNode: async (node) => ({ result: node.id }),
		});

		expect(result.status).toBe("completed");
		expect(result.history.filter((h) => h.nodeId === "join")).toHaveLength(1);
	});
});

describe("script-built graphs: conditional routing is correct", () => {
	/**
	 * The counterpart to the limitation above. These are the cases the audit
	 * found broken; they go through the real script pipeline, which is the path
	 * the workflow tool always uses.
	 */
	async function ranNodes(script: string): Promise<string[]> {
		const { graph } = buildGraphFromScript(script);
		const ran: string[] = [];
		await runSuperstepGraph(graph, {
			runId: "script",
			runNode: async (node) => {
				ran.push(node.id);
				return { result: { ok: true, status: "ok" } };
			},
		});
		return ran;
	}

	const META = `export const meta = { name: "t", description: "d" };\n`;

	it("runs only the branch a conditional edge chose", async () => {
		// Previously ran BOTH deploy and rollback — a workflow that deploys and
		// rolls back at the same time.
		const ran = await ranNodes(`${META}
const g = graph();
g.node("green", agent("green", () => "g"));
g.node("deploy", agent("worker", () => "d"));
g.node("rollback", agent("worker", () => "r"));
g.edge("green", (s, r) => r.ok ? "deploy" : "rollback");
g.edge("deploy", END);
g.edge("rollback", END);
g.run({});`);

		expect(ran).toEqual(["green", "deploy"]);
		expect(ran).not.toContain("rollback");
	});

	it("does not run a not-taken branch inside a fan-out graph", async () => {
		// Previously ran p, a, b, x, y, x — a not-taken branch plus a duplicate.
		const ran = await ranNodes(`${META}
const g = graph();
g.node("p", agent("planner", () => "p"));
g.node("a", agent("worker", () => "a"));
g.node("b", agent("worker", () => "b"));
g.node("x", agent("worker", () => "x"));
g.node("y", agent("worker", () => "y"));
g.edge("p", "a");
g.edge("p", "b");
g.edge("a", (s, r) => r.ok ? "x" : "y");
g.edge("b", END);
g.edge("x", END);
g.edge("y", END);
g.run({});`);

		expect(ran.filter((n) => n === "x")).toHaveLength(1);
		expect(ran).not.toContain("y");
	});

	it("runs a conditional fan-in join exactly once", async () => {
		const ran = await ranNodes(`${META}
const g = graph();
g.node("planner", agent("planner", () => "p"));
g.node("fast", agent("worker", () => "f"));
g.node("slow", agent("worker", () => "s"));
g.node("mid", agent("worker", () => "m"));
g.node("join", agent("worker", () => "j"));
g.edge("planner", "fast");
g.edge("planner", "slow");
g.edge("fast", "join");
g.edge("slow", "mid");
g.edge("mid", (s, r) => "join");
g.edge("join", END);
g.run({});`);

		expect(ran.filter((n) => n === "join")).toHaveLength(1);
	});
});

describe("wave reset under claims + selected", () => {
	/**
	 * A reset must clear `selected` as well as `executed`. Without that, a node
	 * selected in an earlier wave would still count as selected afterwards and
	 * could fire without anything routing to it in the new wave — the same
	 * class of bug the readiness rule exists to prevent.
	 */
	it("does not leak a selection across a reset", async () => {
		const { graph } = buildGraphFromScript(`export const meta = { name: "esc", description: "d" };
const g = graph();
g.node("architect", agent("architect", () => "d"));
g.node("green", agent("green", () => "i"));
g.node("review", agent("reviewer", () => "r"));
g.edge("architect", "green");
g.edge("green", (s, r) => r.status === 'blocked' ? "architect" : "review");
g.edge("review", END);
g.run({});`);

		const calls: Record<string, number> = {};
		const result = await runSuperstepGraph(graph, {
			runId: "reset",
			runNode: async (node) => {
				const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
				// green escalates once, so `review` is passed over in wave 1.
				if (node.id === "green" && call === 1) return { result: { status: "blocked" } };
				return { result: { status: "ok" } };
			},
		});

		expect(result.path).toEqual(["architect", "green", "architect", "green", "review"]);
		expect(result.history.filter((h) => h.nodeId === "review")).toHaveLength(1);
	});

	it("still reproduces the design doc's escalation example exactly", async () => {
		const { graph } = buildGraphFromScript(`export const meta = { name: "d6", description: "d" };
const g = graph();
g.node("planner", agent("planner", () => "p"));
g.node("workerA", agent("worker", () => "a"));
g.node("workerB", agent("worker", () => "b"));
g.node("reviewer", agent("reviewer", () => "r"));
g.edge("planner", "workerA");
g.edge("planner", "workerB");
g.edge("workerA", "reviewer");
g.edge("workerB", (s, r) => r.status === 'blocked' ? "planner" : "reviewer");
g.edge("reviewer", (s, r) => r.status === 'blocked' ? "planner" : END);
g.run({});`);

		const calls: Record<string, number> = {};
		const result = await runSuperstepGraph(graph, {
			runId: "d6",
			runNode: async (node) => {
				const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
				if (node.id === "workerB" && call === 1) {
					return { result: { status: "blocked", blockedOn: "requirements" } };
				}
				return { result: { status: "ok" } };
			},
		});

		// The table in docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md, Decision 6.
		expect(result.iterations).toBe(5); // rounds
		expect(result.nodeExecutions).toBe(7);
		expect(result.history.filter((h) => h.nodeId === "reviewer")).toHaveLength(1);
	});
});
