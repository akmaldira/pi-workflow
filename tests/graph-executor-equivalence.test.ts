/**
 * Equivalence gate: the superstep executor must reproduce the linear walk.
 *
 * This is the evidence that one execution model can replace two. Until these
 * pass, deleting the linear executor would trade a known bug for an unknown
 * one, because the linear executor is currently load-bearing for the
 * correctness of conditional routing.
 *
 * Both executors run the SAME graph and must agree on status, path and final
 * state. The counters deliberately differ (rounds vs steps) and are not
 * compared.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BuiltGraph, GraphState } from "../extensions/graph-dsl.ts";
import { type NodeRunner, runGraph } from "../extensions/graph-executor.ts";
import { runSuperstepGraph } from "../extensions/graph-superstep-executor.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

const META = `export const meta = { name: "eq", description: "equivalence" };\n`;

/**
 * A runner whose answers depend only on node id and visit count, so both
 * executors see identical results for identical walks.
 */
function deterministicRunner(scripted: Record<string, unknown[]> = {}): NodeRunner {
	const calls: Record<string, number> = {};
	return async (node) => {
		const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
		const perVisit = scripted[node.id];
		if (perVisit) {
			// Last entry repeats once the script runs out.
			const value = perVisit[Math.min(call - 1, perVisit.length - 1)];
			return { result: value };
		}
		return { result: { status: "ok", text: node.id } };
	};
}

interface Comparison {
	status: string;
	path: string[];
	state: GraphState;
}

async function compare(
	graph: BuiltGraph,
	scripted: Record<string, unknown[]> = {},
): Promise<{ linear: Comparison; superstep: Comparison }> {
	const linearResult = await runGraph(graph, {
		runId: "lin",
		maxIterations: 50,
		runNode: deterministicRunner(scripted),
	});

	// Force the mode so the same graph goes through the parallel scheduler.
	const superstepResult = await runSuperstepGraph(
		{ ...graph, mode: "superstep" as const },
		{ runId: "sup", maxIterations: 50, runNode: deterministicRunner(scripted) },
	);

	return {
		linear: {
			status: linearResult.status,
			path: linearResult.path,
			state: linearResult.state,
		},
		superstep: {
			status: superstepResult.status,
			path: superstepResult.path,
			state: superstepResult.state,
		},
	};
}

function build(body: string): BuiltGraph {
	return buildGraphFromScript(META + body, { args: { task: "example task" } }).graph;
}

describe("superstep reproduces the linear walk", () => {
	it("simple linear chain", async () => {
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("architect", agent("architect", () => "d"));
g.node("green", agent("green", (s) => "impl " + s.architect));
g.edge("architect", "green");
g.edge("green", END);
g.run({});`),
		);

		expect(superstep.status).toBe(linear.status);
		expect(superstep.path).toEqual(linear.path);
		expect(superstep.state).toEqual(linear.state);
	});

	it("conditional either/or branch — the headline bug", async () => {
		// Previously the superstep executor ran BOTH branches here.
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("green", agent("green", () => "i"));
g.node("deploy", agent("worker", () => "d"));
g.node("rollback", agent("worker", () => "r"));
g.edge("green", (s, r) => r.status === 'ok' ? "deploy" : "rollback");
g.edge("deploy", END);
g.edge("rollback", END);
g.run({});`),
		);

		expect(superstep.path).toEqual(linear.path);
		expect(superstep.path).toContain("deploy");
		expect(superstep.path).not.toContain("rollback");
	});

	it("conditional branch taking the other arm", async () => {
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("green", agent("green", () => "i"));
g.node("deploy", agent("worker", () => "d"));
g.node("rollback", agent("worker", () => "r"));
g.edge("green", (s, r) => r.status === 'ok' ? "deploy" : "rollback");
g.edge("deploy", END);
g.edge("rollback", END);
g.run({});`),
			{ green: [{ status: "failed" }] },
		);

		expect(superstep.path).toEqual(linear.path);
		expect(superstep.path).toContain("rollback");
		expect(superstep.path).not.toContain("deploy");
	});

	it("escalation cycle", async () => {
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("architect", agent("architect", () => "d"));
g.node("green", agent("green", () => "i"));
g.node("reviewer", agent("reviewer", () => "r"));
g.edge("architect", "green");
g.edge("green", (s, r) => r.status === 'blocked' ? "architect" : "reviewer");
g.edge("reviewer", END);
g.run({});`),
			{ green: [{ status: "blocked", blockedOn: "contract" }, { status: "ok" }] },
		);

		expect(superstep.status).toBe(linear.status);
		expect(superstep.path).toEqual(linear.path);
		// The cycle really happened.
		expect(linear.path.filter((n) => n === "architect").length).toBeGreaterThan(1);
	});

	it("iterative refinement whose edge condition mutates state", async () => {
		// Edges now resolve for every possible target, so a mutating condition
		// must still run exactly once per node visit or the counter drifts.
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("planner", agent("planner", () => "draft"));
g.node("reviewer", agent("reviewer", () => "critique"));
g.edge("planner", (s) => {
  s.rounds = (s.rounds ?? 0) + 1;
  return s.rounds < 3 ? "reviewer" : END;
});
g.edge("reviewer", "planner");
g.run({});`),
		);

		expect(superstep.status).toBe(linear.status);
		expect(superstep.path).toEqual(linear.path);
		// The visit counter must land on the same value in both.
		expect(superstep.state.rounds).toBe(linear.state.rounds);
	});

	it("multi-target escalation routing", async () => {
		const { linear, superstep } = await compare(
			build(`
const g = graph();
g.node("architect", agent("architect", () => "contract"));
g.node("red", agent("red", () => "tests"));
g.node("green", agent("green", () => "impl"));
g.edge("architect", "red");
g.edge("red", "green");
g.edge("green", (s, r) => {
  if (r.blockedOn === 'contract') return "architect";
  if (r.blockedOn === 'tests') return "red";
  return END;
});
g.run({});`),
			{
				green: [
					{ status: "blocked", blockedOn: "tests" },
					{ status: "blocked", blockedOn: "contract" },
					{ status: "ok" },
				],
			},
		);

		expect(superstep.status).toBe(linear.status);
		expect(superstep.path).toEqual(linear.path);
	});
});

describe("superstep reproduces the linear walk on every documented example", () => {
	function completeGraphExamples(markdown: string): string[] {
		return [...markdown.matchAll(/```js\n([\s\S]*?)```/g)]
			.map((match) => match[1])
			.filter((block) => block.includes("export const meta") && block.includes("g.run("));
	}

	const SOURCES = ["README.md", path.join("skills", "pi-workflow", "SKILL.md")];

	for (const source of SOURCES) {
		it(`${source} examples agree between executors`, async () => {
			if (!fs.existsSync(source)) return;
			const examples = completeGraphExamples(fs.readFileSync(source, "utf-8"));
			expect(examples.length).toBeGreaterThan(0);

			for (const [index, example] of examples.entries()) {
				const graph = buildGraphFromScript(example, { args: { task: "example task" } }).graph;

				// A genuinely parallel example has no linear semantics to compare
				// against — the linear executor cannot run it at all.
				if (graph.mode === "superstep") continue;

				const { linear, superstep } = await compare(graph);
				expect(superstep.status, `${source} example #${index + 1} status`).toBe(linear.status);
				expect(superstep.path, `${source} example #${index + 1} path`).toEqual(linear.path);
			}
		});
	}
});
