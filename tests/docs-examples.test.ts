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
});
