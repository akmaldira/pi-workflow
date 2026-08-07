/**
 * Behavioural contract for sequential graphs under the single executor.
 *
 * These began as an equivalence gate against a second, linear executor, and
 * they are what justified deleting it: each expected path below is the exact
 * walk that executor produced. It is gone now, so they stand on their own as
 * the guarantee that a graph with no fan-out still behaves like a plain
 * sequential walk — including conditional branches, escalation cycles, and
 * state-mutating edge conditions.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BuiltGraph, GraphState } from "../extensions/graph-dsl.ts";
import type { NodeRunner } from "../extensions/graph-executor.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

const META = `export const meta = { name: "eq", description: "sequential contract" };\n`;

/** Answers depend only on node id and visit count, so a walk is reproducible. */
function deterministicRunner(scripted: Record<string, unknown[]> = {}): NodeRunner {
	const calls: Record<string, number> = {};
	return async (node) => {
		const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
		const perVisit = scripted[node.id];
		if (perVisit) {
			// The last entry repeats once the script runs out.
			return { result: perVisit[Math.min(call - 1, perVisit.length - 1)] };
		}
		return { result: { status: "ok", text: node.id } };
	};
}

interface Walk {
	status: string;
	path: string[];
	state: GraphState;
}

async function walk(graph: BuiltGraph, scripted: Record<string, unknown[]> = {}): Promise<Walk> {
	const result = await runSuperstepGraph(graph, {
		runId: "walk",
		maxIterations: 50,
		runNode: deterministicRunner(scripted),
	});
	return { status: result.status, path: result.path, state: result.state };
}

function build(body: string): BuiltGraph {
	return buildGraphFromScript(META + body, { args: { task: "example task" } }).graph;
}

const BRANCH_GRAPH = `
const g = graph();
g.node("green", agent("green", () => "i"));
g.node("deploy", agent("worker", () => "d"));
g.node("rollback", agent("worker", () => "r"));
g.edge("green", (s, r) => r.status === 'ok' ? "deploy" : "rollback");
g.edge("deploy", END);
g.edge("rollback", END);
g.run({});`;

describe("sequential graphs walk one node at a time", () => {
	it("linear chain", async () => {
		const result = await walk(
			build(`
const g = graph();
g.node("architect", agent("architect", () => "d"));
g.node("green", agent("green", (s) => "impl " + s.architect));
g.edge("architect", "green");
g.edge("green", END);
g.run({});`),
		);

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["architect", "green"]);
	});

	it("conditional either/or runs only the chosen branch", async () => {
		// The headline bug: this used to run BOTH branches.
		const result = await walk(build(BRANCH_GRAPH));

		expect(result.path).toEqual(["green", "deploy"]);
		expect(result.path).not.toContain("rollback");
	});

	it("conditional either/or takes the other arm when the result changes", async () => {
		const result = await walk(build(BRANCH_GRAPH), { green: [{ status: "failed" }] });

		expect(result.path).toEqual(["green", "rollback"]);
		expect(result.path).not.toContain("deploy");
	});

	it("escalation cycle revisits the owner before continuing", async () => {
		const result = await walk(
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

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["architect", "green", "architect", "green", "reviewer"]);
	});

	it("a state-mutating edge condition fires exactly once per visit", async () => {
		// Edges resolve for every possible target now, so a mutating condition
		// must still run once per node visit or the counter drifts.
		const result = await walk(
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

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["planner", "reviewer", "planner", "reviewer", "planner"]);
		expect(result.state.rounds).toBe(3);
	});

	it("multi-target escalation routes to a different owner each time", async () => {
		const result = await walk(
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

		expect(result.status).toBe("completed");
		// Blocked on tests -> red; blocked on contract -> architect; then done.
		expect(result.path).toEqual([
			"architect",
			"red",
			"green",
			"red",
			"green",
			"architect",
			"red",
			"green",
		]);
	});
});

describe("every documented example runs under the single executor", () => {
	function completeGraphExamples(markdown: string): string[] {
		return [...markdown.matchAll(/```js\n([\s\S]*?)```/g)]
			.map((match) => match[1])
			.filter((block) => block.includes("export const meta") && block.includes("g.run("));
	}

	for (const source of ["README.md", path.join("skills", "pi-workflow", "SKILL.md")]) {
		it(`${source} examples complete`, async () => {
			if (!fs.existsSync(source)) return;
			const examples = completeGraphExamples(fs.readFileSync(source, "utf-8"));
			expect(examples.length).toBeGreaterThan(0);

			for (const [index, example] of examples.entries()) {
				const graph = buildGraphFromScript(example, { args: { task: "example task" } }).graph;
				const result = await walk(graph);
				expect(result.status, `${source} example #${index + 1}`).toBe("completed");
			}
		});
	}
});
