import { describe, expect, it } from "vitest";
import { parse } from "acorn";
import { extractConditionalTargets } from "../extensions/graph-edge-targets.ts";

const NODES = new Set([
	"architect",
	"green",
	"reviewer",
	"planner",
	"revise",
	"approve",
	"deploy",
	"rollback",
	"a",
	"b",
	"p",
	"q",
	"m",
	"n",
]);

function extract(source: string, nodes: Set<string> = NODES) {
	const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as never;
	return extractConditionalTargets(ast, nodes);
}

describe("extractConditionalTargets", () => {
	it("reads both arms of a ternary", () => {
		const found = extract(
			`g.edge('green', (state, result) => result.status === 'blocked' ? 'architect' : 'reviewer');`,
		);

		const green = found.get("green")!;
		expect(green.analysable).toBe(true);
		expect(green.targets.sort()).toEqual(["architect", "reviewer"]);
	});

	it("drops string literals that are comparisons, not targets", () => {
		// 'blocked' and 'contract' are compared against, never returned.
		const found = extract(
			`g.edge('green', (s, r) => r.status === 'blocked' && r.blockedOn === 'contract' ? 'architect' : 'reviewer');`,
		);

		expect(found.get("green")!.targets.sort()).toEqual(["architect", "reviewer"]);
	});

	it("reads returns from a block body and records END", () => {
		const found = extract(
			`g.edge('reviewer', (s, r) => { if (r.status === 'blocked') return 'planner'; return END; });`,
		);

		const reviewer = found.get("reviewer")!;
		expect(reviewer.targets).toEqual(["planner"]);
		expect(reviewer.usesEnd).toBe(true);
		expect(reviewer.analysable).toBe(true);
	});

	it("handles multiple returns in one body", () => {
		const found = extract(`g.edge('approve', (state, result) => {
  if (result.text === 'no') return END;
  if (result.text === 'revise') return 'revise';
  return END;
});`);

		const approve = found.get("approve")!;
		expect(approve.targets).toEqual(["revise"]);
		expect(approve.usesEnd).toBe(true);
		expect(approve.analysable).toBe(true);
	});

	it("reads an edge that mutates state before returning", () => {
		// The visit-counter pattern from SKILL.md.
		const found = extract(`g.edge('planner', (s) => {
  s.rounds = (s.rounds ?? 0) + 1;
  return s.rounds < 3 ? 'reviewer' : END;
});`);

		const planner = found.get("planner")!;
		expect(planner.targets).toEqual(["reviewer"]);
		expect(planner.usesEnd).toBe(true);
		expect(planner.analysable).toBe(true);
	});

	it("unions targets across several conditional edges from one node", () => {
		const found = extract(`
g.edge('a', (s, r) => r.x ? 'p' : 'q');
g.edge('a', (s, r) => r.y ? 'm' : 'n');
`);

		// Union rather than per-edge lists: an edge decrements exactly the set
		// it claimed, so the over-claim cancels out.
		expect(found.get("a")!.targets.sort()).toEqual(["m", "n", "p", "q"]);
		expect(found.get("a")!.analysable).toBe(true);
	});

	describe("must flag what it cannot read, rather than under-claim", () => {
		it("flags a non-inline function", () => {
			const found = extract(`g.edge('green', someExternalFn);`);

			const green = found.get("green")!;
			expect(green.analysable).toBe(false);
		});

		it("flags a computed target", () => {
			// The dangerous case: yields an EMPTY target list, which without the
			// flag is indistinguishable from "routes nowhere" and would silently
			// under-claim — exactly the bug this module exists to prevent.
			const found = extract(`g.edge('green', (s, r) => r.next);`);

			const green = found.get("green")!;
			expect(green.targets).toEqual([]);
			expect(green.analysable).toBe(false);
		});

		it("flags a target held in a variable", () => {
			const found = extract(`g.edge('green', (s, r) => { const t = pick(r); return t; });`);

			expect(found.get("green")!.analysable).toBe(false);
		});

		it("flags a partially-computed edge even when one arm is a literal", () => {
			const found = extract(`g.edge('green', (s, r) => r.ok ? 'reviewer' : r.fallback);`);

			const green = found.get("green")!;
			// The readable arm is still recorded, but the edge is not trusted.
			expect(green.targets).toEqual(["reviewer"]);
			expect(green.analysable).toBe(false);
		});
	});

	describe("ignores things that are not conditional edges", () => {
		it("skips direct edges", () => {
			const found = extract(`g.edge('a', 'b'); g.edge('b', END);`);

			// Direct edges declare their own targets; nothing to extract.
			expect(found.size).toBe(0);
		});

		it("does not treat a nested function's return as the edge's target", () => {
			const found = extract(
				`g.edge('green', (s, r) => { const f = () => 'planner'; return r.ok ? 'reviewer' : 'architect'; });`,
			);

			const green = found.get("green")!;
			expect(green.targets.sort()).toEqual(["architect", "reviewer"]);
			expect(green.targets).not.toContain("planner");
		});

		it("ignores unrelated method calls named differently", () => {
			const found = extract(`g.node('a', agent('planner', (s) => 'architect'));`);

			expect(found.size).toBe(0);
		});
	});

	it("filters targets that are not declared nodes", () => {
		const found = extract(`g.edge('green', (s, r) => r.ok ? 'reviewer' : 'not_a_node');`, NODES);

		// An undeclared target is a routing error the executor reports at
		// runtime with a better message than this could.
		expect(found.get("green")!.targets).toEqual(["reviewer"]);
	});
});
