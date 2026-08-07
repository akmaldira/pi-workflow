/**
 * Validates the graph examples in the documentation against the real
 * validator.
 *
 * Documentation that does not run is worse than none: a reader copies it,
 * hits a validation error, and stops trusting the rest. This catches drift
 * the moment the DSL changes.
 *
 * Only fenced ```js blocks containing a full script (meta header plus a
 * g.run call) are checked. API-shape sketches are fenced as ```text
 * precisely so they are not mistaken for runnable code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

function completeGraphExamples(markdown: string): string[] {
	return [...markdown.matchAll(/```js\n([\s\S]*?)```/g)]
		.map((match) => match[1])
		.filter((block) => block.includes("export const meta") && block.includes("g.run("));
}

const DOCS = ["README.md", path.join("docs", "GRAPH-WORKFLOW-DESIGN.md")];
const SKILL = path.join("skills", "pi-workflow", "SKILL.md");

describe("documentation examples", () => {
	for (const doc of DOCS) {
		describe(doc, () => {
			const exists = fs.existsSync(doc);

			it.skipIf(!exists)("every complete graph example validates", () => {
				const examples = completeGraphExamples(fs.readFileSync(doc, "utf-8"));

				for (const [index, example] of examples.entries()) {
					expect(
						() => buildGraphFromScript(example, { args: { task: "example task" } }),
						`${doc} example #${index + 1} failed to validate:\n\n${example}`,
					).not.toThrow();
				}
			});
		});
	}

	it("README documents at least one runnable graph", () => {
		// A README that only shows fragments leaves a reader with nothing to
		// copy and no way to tell whether the fragments compose.
		expect(completeGraphExamples(fs.readFileSync("README.md", "utf-8")).length).toBeGreaterThan(0);
	});

	it("README does not reference the removed imperative API", () => {
		const readme = fs.readFileSync("README.md", "utf-8");

		for (const removed of ["parallel(", "pipeline(", "phase("]) {
			expect(readme, `README still documents the removed ${removed})`).not.toContain(removed);
		}
	});

	it("the agents README documents are the agents that ship", async () => {
		// A roster table that drifts from the shipped agents sends people
		// looking for roles that do not exist.
		const { discoverAgents } = await import("../extensions/agents.ts");
		const shipped = discoverAgents("/nonexistent-project", "project", { skipSettings: true })
			.agents.filter((a) => a.source === "builtin")
			.map((a) => a.name);
		const readme = fs.readFileSync("README.md", "utf-8");

		for (const name of shipped) {
			expect(readme, `README omits bundled agent "${name}"`).toContain(`\`${name}\``);
		}
	});

	describe(SKILL, () => {
		it.skipIf(!fs.existsSync(SKILL))("every complete graph example validates", () => {
			// The skill is the document the model reads to learn the API. An
			// example here that fails validation is copied verbatim and breaks
			// the run -- this is the highest-value doc to keep honest.
			const examples = completeGraphExamples(fs.readFileSync(SKILL, "utf-8"));
			expect(examples.length, "SKILL should contain at least one complete graph example").toBeGreaterThan(0);

			for (const [index, example] of examples.entries()) {
				expect(
					() => buildGraphFromScript(example, { args: { task: "example task" } }),
					`${SKILL} example #${index + 1} failed to validate:\n\n${example}`,
				).not.toThrow();
			}
		});

		it.skipIf(!fs.existsSync(SKILL))("does not reference the removed imperative API", () => {
			const skill = fs.readFileSync(SKILL, "utf-8");

			for (const removed of ["parallel(", "pipeline(", "phase(", "await agent("]) {
				expect(skill, `SKILL still documents the removed ${removed})`).not.toContain(removed);
			}
		});

		it.skipIf(!fs.existsSync(SKILL))("teaches cyclic routing (node reuse), not only flat chains", () => {
			// The single most common misuse is flattening an iterative task
			// into a linear chain of uniquely-named nodes (planner_1, planner_2,
			// ...) that never revisits a node. If the skill stops teaching that
			// a node can be routed back to, the model will revert to that
			// mistake. This guards the lesson.
			const skill = fs.readFileSync(SKILL, "utf-8");
			expect(skill, "SKILL must explain that revisiting a node overwrites its state").toMatch(/overwrite/i);
			expect(skill, "SKILL must show a cyclic example that reuses a node id").toMatch(/rounds/);
		});

		it.skipIf(!fs.existsSync(SKILL))("teaches custom-agent authors the escalation protocol", () => {
			// Coordination depends on agents emitting STATUS: blocked. The
			// protocol is now auto-injected at spawn time, so even a custom agent
			// whose author omitted the block participates in routing. This guards
			// both halves of that lesson.
			const skill = fs.readFileSync(SKILL, "utf-8");
			expect(skill, "SKILL must teach the STATUS: blocked protocol for custom agents").toMatch(/STATUS: blocked/);
			expect(skill, "SKILL must teach that escalating is a good outcome").toMatch(/escalating is a successful outcome/i);
			expect(skill, "SKILL must teach that the protocol is auto-injected").toMatch(/auto-inject/i);
		});

		it.skipIf(!fs.existsSync(SKILL))("documents the BLOCKED_ON vocabulary for edge routing", () => {
			// The agent writing a graph needs to know every blockedOn value so it
			// can write correct edge conditions. If a category is missing from
			// the SKILL, the model will write edges that never match it.
			const skill = fs.readFileSync(SKILL, "utf-8");
			for (const category of ["contract", "tests", "requirements", "information", "environment", "conflict"]) {
				expect(skill, `SKILL must document blockedOn value "${category}"`).toContain(`\`${category}\``);
			}
			// The result shape table must be present so the model knows what
			// fields are available in edge conditions.
			expect(skill, "SKILL must document result.status").toMatch(/result.*status/i);
			expect(skill, "SKILL must document result.blockedOn").toMatch(/result.*blockedOn/i);
		});

		it.skipIf(!fs.existsSync(SKILL))("teaches the parallel fan-out rules", () => {
			// Parallel execution has three non-obvious rules. Each one, if not
			// taught, produces a specific bug: a fan-in node read as if it ran
			// early, a branch written to read its sibling, or two branches
			// clobbering one shared state key.
			const skill = fs.readFileSync(SKILL, "utf-8");
			expect(skill, "SKILL must explain that >1 outgoing edge fans out").toMatch(
				/more than one outgoing edge/i,
			);
			expect(skill, "SKILL must explain AND fan-in (waits for all)").toMatch(/waits for \*?all\*?/i);
			expect(skill, "SKILL must warn that siblings cannot see each other").toMatch(
				/cannot see each other/i,
			);
			expect(skill, "SKILL must warn about last-write-wins on shared keys").toMatch(
				/last-write-wins/i,
			);
			expect(skill, "SKILL must explain the two counters").toMatch(/node executions across/i);
		});

		it.skipIf(!fs.existsSync(SKILL))("ships a parallel fan-out example", () => {
			// A fan-out example must exist, or the parallel rules are documented
			// without anything demonstrating them.
			const skill = fs.readFileSync(SKILL, "utf-8");
			const examples = completeGraphExamples(skill);
			const hasFanOut = examples.some((example) => {
				const graph = buildGraphFromScript(example, { args: { task: "t" } }).graph;
				return [...graph.edges.values()].some((edges) => edges.length > 1);
			});
			expect(hasFanOut, "SKILL must contain a fan-out example").toBe(true);
		});
	});
});
