/**
 * Adversarial tests for the graph script sandbox.
 *
 * These exist because the ordinary validator tests gave false confidence:
 * 55 of them passed against a build that leaked host intrinsics into the
 * sandbox, letting a script compile arbitrary code and pollute this
 * process's own Object.prototype. The unit tests asserted that the things
 * they thought of were blocked; they could not assert anything about the
 * things they did not think of.
 *
 * Every case here is a real escape attempt run end to end. A failure means
 * a script authored by a model can do something it should not.
 */

import { describe, expect, it } from "vitest";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

const META = `export const meta = { name: "escape", description: "escape attempt" };`;
const VALID_TAIL = `
const g = graph();
g.node("a", agent("x", () => "y"));
g.edge("a", END);
g.run();
`;

/** Runs an attempt; returns whether the script was allowed to build. */
function attempt(code: string): { built: boolean; message: string } {
	try {
		buildGraphFromScript(`${META}\n${code}\n${VALID_TAIL}`);
		return { built: true, message: "" };
	} catch (error) {
		return { built: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function expectBlocked(code: string): void {
	const { built, message } = attempt(code);
	expect(built, `script was allowed to build:\n${code}`).toBe(false);
	expect(message.length).toBeGreaterThan(0);
}

describe("sandbox escape: reaching a function constructor", () => {
	// The canonical vm escape. An ordinary value's constructor chain leads to
	// Function, and Function compiles strings into code.
	const attempts: [string, string][] = [
		["arrow function constructor", `const F = (() => {}).constructor; F("return process")();`],
		["function expression constructor", `const F = (function(){}).constructor; F("return process")();`],
		["array literal constructor", `const F = [].constructor.constructor; F("return process")();`],
		["string literal constructor", `const F = "".constructor.constructor; F("return globalThis")();`],
		["number literal constructor", `const F = (0).constructor.constructor; F("return process")();`],
		["object literal constructor", `const F = ({}).constructor.constructor; F("return process")();`],
		["Object global constructor", `const F = Object.constructor; F("return process")();`],
		["Error instance constructor", `const F = Error().constructor.constructor; F("return process")();`],
		["JSON constructor", `const F = JSON.constructor; F("return process")();`],
		["template literal coercion", "const s = `${(() => {}).constructor}`;"],
		["prototype walk to constructor", `const F = Object.getPrototypeOf(function(){}).constructor;`],
	];

	for (const [label, code] of attempts) {
		it(`blocks ${label}`, () => expectBlocked(code));
	}
});

describe("sandbox escape: prototype manipulation", () => {
	const attempts: [string, string][] = [
		["direct prototype write", `Object.prototype.pwned = 1;`],
		["__proto__ write", `({}).__proto__.pwned = 1;`],
		["__proto__ read", `const p = ({}).__proto__;`],
		["getPrototypeOf", `const p = Object.getPrototypeOf({});`],
		["setPrototypeOf", `Object.setPrototypeOf({}, null);`],
		["defineProperty", `Object.defineProperty({}, "x", { value: 1 });`],
		["__defineGetter__", `({}).__defineGetter__("x", () => 1);`],
	];

	for (const [label, code] of attempts) {
		it(`blocks ${label}`, () => expectBlocked(code));
	}

	it("leaves this process's Object.prototype untouched", () => {
		// The regression that motivated this file: host intrinsics were being
		// injected into the sandbox, so a script's prototype writes landed on
		// the prototypes this very test process runs on.
		attempt(`Object.prototype.__hostPwned = 1;`);
		attempt(`({}).__proto__.__hostPwned = 1;`);

		expect(({} as Record<string, unknown>).__hostPwned).toBeUndefined();
		expect((Object.prototype as Record<string, unknown>).__hostPwned).toBeUndefined();
	});
});

describe("sandbox escape: reaching ambient authority", () => {
	const attempts: [string, string][] = [
		["require", `const fs = require("fs");`],
		["process", `const home = process.env.HOME;`],
		["globalThis", `const g2 = globalThis;`],
		["global", `const g2 = global;`],
		["this at top level", `const g2 = this;`],
		["eval", `eval("process.exit(1)");`],
		["Function", `const f = Function("return 1");`],
		["fetch", `fetch("http://example.com");`],
		["Buffer", `Buffer.from("x");`],
		["child_process", `const cp = child_process.execSync("ls");`],
		["dynamic import", `import("node:fs");`],
		["import.meta", `const u = import.meta.url;`],
		["Reflect", `Reflect.ownKeys({});`],
		["Proxy", `new Proxy({}, {});`],
		["setTimeout", `setTimeout(() => {}, 0);`],
		["computed name assembly", `const r = this["req" + "uire"];`],
	];

	for (const [label, code] of attempts) {
		it(`blocks ${label}`, () => expectBlocked(code));
	}
});

describe("sandbox escape: import and module surfaces", () => {
	it("blocks a static import even before the meta export", () => {
		const { built } = (() => {
			try {
				buildGraphFromScript(`import fs from "node:fs";\n${META}\n${VALID_TAIL}`);
				return { built: true };
			} catch {
				return { built: false };
			}
		})();

		expect(built).toBe(false);
	});

	const attempts: [string, string][] = [
		["module.exports", `module.exports = 1;`],
		["exports", `exports.x = 1;`],
		["__dirname", `const d = __dirname;`],
		["__filename", `const f = __filename;`],
	];

	for (const [label, code] of attempts) {
		it(`blocks ${label}`, () => expectBlocked(code));
	}
});

describe("sandbox escape: resource exhaustion", () => {
	it("stops an infinite loop at definition time", () => {
		const { built, message } = (() => {
			try {
				buildGraphFromScript(`${META}\nwhile (true) {}\n${VALID_TAIL}`, { timeoutMs: 50 });
				return { built: true, message: "" };
			} catch (error) {
				return { built: false, message: error instanceof Error ? error.message : String(error) };
			}
		})();

		expect(built).toBe(false);
		expect(message).toMatch(/failed to evaluate|timed out/i);
	});

	it("stops unbounded recursion", () => {
		expectBlocked(`const f = (n) => f(n + 1); f(0);`);
	});
});

describe("args are isolated from the host", () => {
	it("does not expose the caller's object to the script", () => {
		// args crosses a realm boundary, so it is rebuilt as plain data. A
		// live reference would be both a mutation channel back into caller
		// state and another route to a host-realm constructor.
		const hostArgs = { task: "ship", nested: { value: 1 } };
		const { graph } = buildGraphFromScript(
			`${META}\nconst g = graph();\ng.node("a", agent("x", () => "y"));\ng.edge("a", END);\ng.run({ passed: args.task, nested: args.nested });`,
			{ args: hostArgs },
		);

		expect(graph.initialState.passed).toBe("ship");
		expect(graph.initialState.nested).toEqual({ value: 1 });
		// Structurally equal but not the same object.
		expect(graph.initialState.nested).not.toBe(hostArgs.nested);
	});

	it("rejects args that cannot cross as plain data", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() =>
			buildGraphFromScript(`${META}\n${VALID_TAIL}`, { args: circular }),
		).toThrow(/JSON-serialisable/);
	});
});

describe("legitimate scripts still work", () => {
	it("allows the routing logic a real coordination graph needs", () => {
		// The sandbox is useless if it blocks ordinary code. This is the
		// escalation pattern the whole design exists to support.
		const script = `${META}
const g = graph();
g.node("architect", agent("architect", (s) => "Design: " + s.task));
g.node("green", agent("green", (s) => "Implement:\\n" + s.architect));
g.node("review", human((s) => "Review:\\n" + s.green));
g.node("approve", human("Ship it?", { options: ["yes", "no"], default: "no" }));

g.edge("architect", "green");
g.edge("green", (state, result) => {
  const blockers = ["contract", "tests"];
  if (result && result.status === "blocked") {
    if (blockers.includes(result.blockedOn)) return "architect";
    return "review";
  }
  return "review";
});
g.edge("review", "approve");
g.edge("approve", END);
g.run({ task: args.task });
`;

		const { graph, meta } = buildGraphFromScript(script, { args: { task: "add auth" } });

		expect(meta.name).toBe("escape");
		expect([...graph.nodes.keys()]).toEqual(["architect", "green", "review", "approve"]);
		expect(graph.initialState).toEqual({ task: "add auth" });

		const edge = graph.edges.get("green")?.[0];
		if (edge?.type !== "conditional") throw new Error("expected a conditional edge");
		expect(edge.condition({}, { status: "blocked", blockedOn: "contract" })).toBe("architect");
		expect(edge.condition({}, { status: "ok" })).toBe("review");
	});

	it("allows string, array, and JSON work inside prompts", () => {
		const script = `${META}
const g = graph();
const roles = ["planner", "architect"];
g.node("a", agent(roles[0], (s) => {
  const items = (s.list || []).map((x) => x.toUpperCase()).join(", ");
  return \`Task: \${s.task}\\nItems: \${items}\\nRaw: \${JSON.stringify(s)}\`;
}));
g.edge("a", END);
g.run({ task: "t", list: ["a", "b"] });
`;

		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("allows Math for ordinary arithmetic", () => {
		// Math.random is rejected separately as non-determinism; the rest of
		// Math is fine and blocking it would be gratuitous.
		const script = `${META}
const g = graph();
g.node("a", agent("x", (s) => "n=" + Math.min(s.n, 10)));
g.edge("a", END);
g.run({ n: 3 });
`;

		expect(() => buildGraphFromScript(script)).not.toThrow();
	});
});
