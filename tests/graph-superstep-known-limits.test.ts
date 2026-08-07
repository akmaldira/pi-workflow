/**
 * Known limitations of the superstep executor.
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
import { runSuperstepGraph } from "../extensions/graph-superstep-executor.ts";

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

describe("KNOWN LIMITATION: AND fan-in does not cover conditional in-edges", () => {
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
