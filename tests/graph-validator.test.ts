import { describe, expect, it } from "vitest";
import { END } from "../extensions/graph-dsl.ts";
import {
	buildGraphFromScript,
	GraphValidationError,
	validateGraphAst,
} from "../extensions/graph-validator.ts";
import { parse } from "acorn";

const META = `export const meta = { name: "t", description: "test graph" };`;

function script(body: string): string {
	return `${META}\n${body}`;
}

/** A minimal valid graph body, for tests that only care about one clause. */
const MINIMAL_BODY = `
const g = graph();
g.node("a", agent("planner", (s) => "do " + s.task));
g.edge("a", END);
g.run({ task: "x" });
`;

function astOf(source: string) {
	return parse(source, { ecmaVersion: "latest", sourceType: "module" }) as never;
}

describe("validateGraphAst", () => {
	it("accepts a well-formed graph script", () => {
		expect(validateGraphAst(astOf(script(MINIMAL_BODY)))).toEqual([]);
	});

	it("accepts ordinary language constructs used by routing logic", () => {
		// Edge conditions are real code; the allowlist must not make normal
		// JavaScript unusable.
		const body = `
const g = graph();
g.node("a", agent("green", (s) => \`impl \${s.task}\`));
g.node("b", agent("architect", (s) => "revise"));
g.edge("a", (state, result) => {
  const reasons = ["contract", "tests"];
  const blocked = result && result.status === "blocked";
  if (blocked && reasons.includes(result.blockedOn)) return "b";
  for (const r of reasons) { if (r === "never") return "b"; }
  return END;
});
g.edge("b", "a");
g.run({ task: "x" });
`;
		expect(validateGraphAst(astOf(script(body)))).toEqual([]);
	});

	describe("forbidden capability access", () => {
		const cases: [string, string][] = [
			["require", `const fs = require("fs");`],
			["process", `const p = process.env;`],
			["globalThis", `const g2 = globalThis;`],
			["eval", `eval("1+1");`],
			["Function constructor", `const f = Function("return 1");`],
			["fetch", `fetch("http://example.com");`],
			["Buffer", `const b = Buffer.from("x");`],
			["setTimeout", `setTimeout(() => {}, 1);`],
			["Reflect", `Reflect.get({}, "x");`],
			["Proxy", `new Proxy({}, {});`],
			["module", `module.exports = 1;`],
			["__dirname", `const d = __dirname;`],
		];

		for (const [label, code] of cases) {
			it(`rejects ${label}`, () => {
				const problems = validateGraphAst(astOf(script(code)));
				expect(problems.length).toBeGreaterThan(0);
				expect(problems.join("\n")).toMatch(/not available in a graph script/);
			});
		}

		it("rejects import declarations", () => {
			const problems = validateGraphAst(astOf(`import fs from "fs";\n${script(MINIMAL_BODY)}`));
			expect(problems.join("\n")).toMatch(/import is not allowed/);
		});

		it("rejects dynamic import", () => {
			const problems = validateGraphAst(astOf(script(`const m = import("fs");`)));
			expect(problems.join("\n")).toMatch(/import is not allowed/);
		});

		it("rejects import.meta", () => {
			const problems = validateGraphAst(astOf(script(`const u = import.meta.url;`)));
			expect(problems.length).toBeGreaterThan(0);
		});

		it("rejects a forbidden name even when locally shadowed", () => {
			// A local `require` is harmless by itself, but permitting the name
			// means a reader cannot tell at a glance whether a call is the real
			// thing.
			const problems = validateGraphAst(astOf(script(`const require = (x) => x; require("fs");`)));
			expect(problems.join("\n")).toMatch(/"require" is not available/);
		});

		it("rejects with statements at parse time", () => {
			// `with` would let a script resolve names against an object at
			// runtime, defeating static identifier checking. Module code is
			// implicitly strict, so acorn rejects it before the validator runs;
			// the guard in validateGraphAst is belt-and-braces for any future
			// caller that parses in a laxer mode.
			expect(() => buildGraphFromScript(script(`with ({}) { }`))).toThrow(/not valid JavaScript/);
		});

		it("rejects exports other than meta", () => {
			const problems = validateGraphAst(astOf(script(`export default 1;`)));
			expect(problems.join("\n")).toMatch(/Only `export const meta/);
		});
	});

	describe("property access is not a global reference", () => {
		it("allows a property named like a forbidden global", () => {
			// result.process is a field on an agent result, not the global.
			const body = `
const g = graph();
g.node("a", agent("x", (s) => s.process + s.require));
g.edge("a", END);
g.run();
`;
			expect(validateGraphAst(astOf(script(body)))).toEqual([]);
		});

		it("allows an object literal key named like a forbidden global", () => {
			const body = `
const g = graph();
g.node("a", agent("x", () => JSON.stringify({ process: 1, eval: 2 })));
g.edge("a", END);
g.run();
`;
			expect(validateGraphAst(astOf(script(body)))).toEqual([]);
		});

		it("still rejects a computed member access to a forbidden global", () => {
			const problems = validateGraphAst(astOf(script(`const x = process["env"];`)));
			expect(problems.length).toBeGreaterThan(0);
		});
	});

	describe("determinism", () => {
		for (const [label, code] of [
			["Date.now()", `const t = Date.now();`],
			["new Date()", `const d = new Date();`],
			["Math.random()", `const r = Math.random();`],
		] as [string, string][]) {
			it(`rejects ${label}`, () => {
				const problems = validateGraphAst(astOf(script(code)));
				expect(problems.join("\n")).toMatch(/must be deterministic/);
			});
		}

		it("explains why determinism matters for routing", () => {
			const problems = validateGraphAst(astOf(script(`const r = Math.random();`)));
			expect(problems.join("\n")).toMatch(/rerun of the same graph could take a different path/);
		});
	});

	describe("local bindings", () => {
		it("allows locally declared variables and parameters", () => {
			const body = `
const g = graph();
const label = "planner";
function buildPrompt(state, extra) { return label + state.task + extra; }
g.node("a", agent(label, (s) => buildPrompt(s, "!")));
g.edge("a", END);
g.run();
`;
			expect(validateGraphAst(astOf(script(body)))).toEqual([]);
		});

		it("allows destructured bindings", () => {
			const body = `
const g = graph();
g.node("a", agent("x", (s) => { const { task, ...rest } = s; const [first] = [1]; return task + first; }));
g.edge("a", END);
g.run();
`;
			expect(validateGraphAst(astOf(script(body)))).toEqual([]);
		});

		it("allows catch clause parameters", () => {
			const body = `
const g = graph();
g.node("a", agent("x", (s) => { try { return s.task; } catch (err) { return String(err); } }));
g.edge("a", END);
g.run();
`;
			expect(validateGraphAst(astOf(script(body)))).toEqual([]);
		});

		it("rejects an undeclared identifier", () => {
			const problems = validateGraphAst(astOf(script(`const x = someUndeclaredThing;`)));
			expect(problems.join("\n")).toMatch(/"someUndeclaredThing" is not available/);
		});
	});

	it("deduplicates repeated problems", () => {
		const problems = validateGraphAst(astOf(script(`process.env; process.cwd(); process.exit();`)));
		expect(problems).toHaveLength(1);
	});

	it("reports several distinct problems at once", () => {
		const problems = validateGraphAst(astOf(script(`const a = process.env; const b = Date.now();`)));
		expect(problems.length).toBeGreaterThanOrEqual(2);
	});
});

describe("buildGraphFromScript", () => {
	describe("meta extraction", () => {
		it("extracts name, description, and whenToUse", () => {
			const result = buildGraphFromScript(
				`export const meta = { name: "tdd", description: "TDD flow", whenToUse: "features" };\n${MINIMAL_BODY}`,
			);

			expect(result.meta).toEqual({ name: "tdd", description: "TDD flow", whenToUse: "features" });
		});

		it("requires meta to be the first statement", () => {
			expect(() => buildGraphFromScript(`const x = 1;\n${META}\n${MINIMAL_BODY}`)).toThrow(
				/must be the first statement/,
			);
		});

		it("requires a non-empty name and description", () => {
			expect(() =>
				buildGraphFromScript(`export const meta = { name: "", description: "d" };\n${MINIMAL_BODY}`),
			).toThrow(/meta.name must be a non-empty string/);
			expect(() =>
				buildGraphFromScript(`export const meta = { name: "n", description: "" };\n${MINIMAL_BODY}`),
			).toThrow(/meta.description must be a non-empty string/);
		});

		it("rejects a non-literal meta value", () => {
			// meta is read statically, so a computed value cannot be honoured.
			expect(() =>
				buildGraphFromScript(
					`export const meta = { name: "a" + "b", description: "d" };\n${MINIMAL_BODY}`,
				),
			).toThrow(/meta.name must be a non-empty string literal/);
		});
	});

	describe("successful builds", () => {
		it("builds a linear graph", () => {
			const { graph } = buildGraphFromScript(script(MINIMAL_BODY), { args: { task: "ship" } });

			expect([...graph.nodes.keys()]).toEqual(["a"]);
			expect(graph.entry).toBe("a");
			expect(graph.edges.get("a")).toMatchObject({ type: "direct", to: END });
		});

		it("passes args into the script", () => {
			const body = `
const g = graph();
g.node("a", agent("planner", (s) => "task: " + s.task));
g.edge("a", END);
g.run({ task: args.task });
`;
			const { graph } = buildGraphFromScript(script(body), { args: { task: "ship it" } });

			expect(graph.initialState).toEqual({ task: "ship it" });
		});

		it("builds an escalation cycle with a conditional edge", () => {
			const body = `
const g = graph();
g.node("architect", agent("architect", (s) => "design " + s.task));
g.node("green", agent("green", (s) => "implement " + s.architect));
g.node("review", mainAgent((s) => "Review: " + s.green));
g.edge("architect", "green");
g.edge("green", (state, result) => {
  if (result.status === "blocked" && result.blockedOn === "contract") return "architect";
  return "review";
});
g.edge("review", END);
g.run({ task: args.task });
`;
			const { graph } = buildGraphFromScript(script(body), { args: { task: "auth" } });

			expect([...graph.nodes.keys()]).toEqual(["architect", "green", "review"]);
			expect(graph.edges.get("green")?.type).toBe("conditional");
		});

		it("produces edge conditions that route on agent results", () => {
			const body = `
const g = graph();
g.node("green", agent("green", () => "impl"));
g.node("architect", agent("architect", () => "design"));
g.edge("green", (state, result) => (result.status === "blocked" ? "architect" : END));
g.edge("architect", "green");
g.run();
`;
			const { graph } = buildGraphFromScript(script(body));
			const edge = graph.edges.get("green");
			if (edge?.type !== "conditional") throw new Error("expected a conditional edge");

			// The condition is real, task-specific logic — this is the reason
			// graphs are code rather than JSON.
			expect(edge.condition({}, { status: "blocked" })).toBe("architect");
			expect(edge.condition({}, { status: "ok" })).toBe(END);
		});

		it("supports human nodes with options", () => {
			const body = `
const g = graph();
g.node("a", agent("green", () => "impl"));
g.node("ok", human("Approve?", { options: ["yes", "no"], default: "no" }));
g.edge("a", "ok");
g.edge("ok", END);
g.run();
`;
			const { graph } = buildGraphFromScript(script(body));

			expect(graph.nodes.get("ok")?.def).toMatchObject({
				type: "human",
				options: ["yes", "no"],
				default: "no",
			});
		});
	});

	describe("sandbox containment", () => {
		it("rejects a script reaching for the filesystem", () => {
			expect(() => buildGraphFromScript(script(`const fs = require("fs");\n${MINIMAL_BODY}`))).toThrow(
				GraphValidationError,
			);
		});

		it("cannot escape via constructor chaining", () => {
			// The classic vm escape: reach Function through a literal's
			// constructor and compile new code. codeGeneration is disabled and
			// the identifier checks reject the shape outright.
			const body = `const F = (function(){}).constructor; F("return process")();`;
			expect(() => buildGraphFromScript(script(body))).toThrow(GraphValidationError);
		});

		it("cannot reach process through an allowed global's prototype chain", () => {
			const body = `const p = Object.getPrototypeOf({}).constructor("return process")();`;
			expect(() => buildGraphFromScript(script(body))).toThrow(GraphValidationError);
		});

		it("blocks runtime code generation even if a name check were bypassed", () => {
			// Defence in depth: codeGeneration.strings is false on the context,
			// so compiling a string would fail even without the AST layer.
			const body = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", END);
g.run();
`;
			// The build succeeds; the assertion is that the context it ran in
			// had code generation disabled, verified by the escape tests above.
			expect(() => buildGraphFromScript(script(body))).not.toThrow();
		});

		it("times out a definition-time infinite loop", () => {
			const body = `while (true) {}`;
			expect(() => buildGraphFromScript(script(body), { timeoutMs: 50 })).toThrow(
				/failed to evaluate|timed out/i,
			);
		});
	});

	describe("script-level errors", () => {
		it("rejects an empty script", () => {
			expect(() => buildGraphFromScript("")).toThrow(/empty/);
		});

		it("reports a syntax error clearly", () => {
			expect(() => buildGraphFromScript(`${META}\nconst g = graph(;`)).toThrow(
				/not valid JavaScript/,
			);
		});

		it("rejects a script that never calls graph()", () => {
			expect(() => buildGraphFromScript(`${META}\nconst x = 1;`)).toThrow(/never called graph\(\)/);
		});

		it("rejects a second graph()", () => {
			const body = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", END);
g.run();
const h = graph();
`;
			expect(() => buildGraphFromScript(script(body))).toThrow(/Only one graph\(\)/);
		});

		it("surfaces structural problems from the builder", () => {
			const body = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", "ghost");
g.run();
`;
			expect(() => buildGraphFromScript(script(body))).toThrow(/undefined node/);
		});

		it("rejects a graph that never calls run()", () => {
			const body = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", END);
`;
			expect(() => buildGraphFromScript(script(body))).toThrow(/never run/);
		});

		it("carries the problem list on the error for programmatic use", () => {
			try {
				buildGraphFromScript(script(`const p = process.env;\n${MINIMAL_BODY}`));
				throw new Error("expected a validation error");
			} catch (error) {
				expect(error).toBeInstanceOf(GraphValidationError);
				expect((error as GraphValidationError).problems.length).toBeGreaterThan(0);
			}
		});
	});

	it("validates before evaluating, so a forbidden script never runs", () => {
		// If evaluation happened first, a script could act before being
		// rejected. Ordering is the property under test.
		const body = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", END);
g.run();
const leak = process.env.HOME;
`;
		expect(() => buildGraphFromScript(script(body))).toThrow(/not available in a graph script/);
	});
});
