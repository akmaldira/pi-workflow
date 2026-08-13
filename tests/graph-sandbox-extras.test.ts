/**
 * Tests for the sandboxExtras feature in graph-validator:
 * - plan and contract objects are available inside graph scripts
 * - all methods work (create, get, list, edit, delete, propose, supersede,
 *   isExists, length, indexOf)
 * - AST validator accepts plan/contract identifiers when they are registered
 * - unknown extras still blocked (error message lists all allowed globals)
 * - cwd binding is correct (writes land in the right directory)
 * - works in both edge conditions and prompt functions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildGraphFromScript,
	validateGraphAst,
} from "../extensions/graph-validator.ts";
import {
	planCreate,
	planIsExists,
	planLength,
	planIndexOf,
} from "../extensions/plan-tool.ts";
import {
	contractCreate,
	contractPropose,
	contractIsExists,
	contractLength,
	contractIndexOf,
} from "../extensions/contract-tool.ts";
import { makePlanSandboxForTest, makeContractSandboxForTest } from "./helpers/sandbox-extras.ts";
import type { AgentNodeDef } from "../extensions/graph-dsl.ts";
import * as acorn from "acorn";

/** Helper: get the promptFn from a built graph node. */
function promptFnOf(graph: ReturnType<typeof buildGraphFromScript>["graph"], id: string) {
	const node = graph.nodes.get(id);
	if (!node) throw new Error(`Node "${id}" not found`);
	if (node.def.type !== "agent") throw new Error(`Node "${id}" is not an agent node`);
	return (node.def as AgentNodeDef).promptFn;
}

/** Helper: get the condition fn from a built graph edge. */
function conditionOf(graph: ReturnType<typeof buildGraphFromScript>["graph"], from: string) {
	const edges = graph.edges.get(from) ?? [];
	const edge = edges.find((e) => e.type === "conditional");
	if (!edge || edge.type !== "conditional") throw new Error(`No conditional edge from "${from}"`);
	return edge.condition;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-extras-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── AST validation ────────────────────────────────────────────────────────────

describe("AST validation with sandboxExtras", () => {
	it("accepts 'plan' identifier when registered as extraGlobal", () => {
		const ast = acorn.parse("plan.get('foo');", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		const errors = validateGraphAst(ast, { extraGlobals: ["plan"] });
		expect(errors).toEqual([]);
	});

	it("accepts 'contract' identifier when registered as extraGlobal", () => {
		const ast = acorn.parse("contract.list();", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		const errors = validateGraphAst(ast, { extraGlobals: ["contract"] });
		expect(errors).toEqual([]);
	});

	it("still rejects 'plan' when NOT registered as extraGlobal", () => {
		const ast = acorn.parse("plan.get('foo');", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		const errors = validateGraphAst(ast, {});
		expect(errors.some((e) => e.includes('"plan"'))).toBe(true);
	});

	it("error message lists extra globals when they are registered", () => {
		const ast = acorn.parse("unknownThing;", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		const errors = validateGraphAst(ast, { extraGlobals: ["plan", "contract"] });
		expect(errors[0]).toContain("plan");
		expect(errors[0]).toContain("contract");
	});
});

// ── plan sandbox object ───────────────────────────────────────────────────────

describe("plan sandbox in graph script", () => {
	it("plan.isExists returns false for a missing plan", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => plan.isExists('nonexistent') ? 'yes' : 'no'));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("no");
	});

	it("plan.isExists returns true after plan.create", () => {
		planCreate(tmpDir, "My Plan", "# My Plan\n\nContent here.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => plan.isExists('my-plan') ? 'yes' : 'no'));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
	});

	it("plan.length returns correct count", () => {
		planCreate(tmpDir, "Plan A", "# Plan A\n\nA.");
		planCreate(tmpDir, "Plan B", "# Plan B\n\nB.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => String(plan.length())));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("2");
	});

	it("plan.indexOf finds a plan by name fragment", () => {
		planCreate(tmpDir, "Auth Plan", "# Auth Plan\n\nDesign auth.");
		planCreate(tmpDir, "DB Plan", "# DB Plan\n\nDesign DB.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const found = plan.indexOf(p => p.name.includes('Auth'));
  return found ? found.id : 'none';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("auth-plan");
	});

	it("plan.indexOf returns null when nothing matches", () => {
		planCreate(tmpDir, "Auth Plan", "# Auth Plan\n\nContent.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const found = plan.indexOf(p => p.name.includes('XYZ'));
  return found === null ? 'null' : 'found';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("null");
	});

	it("plan.get returns content in prompt function", () => {
		planCreate(tmpDir, "My Plan", "# My Plan\n\nThe content.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const p = plan.get('my-plan');
  return p.ok ? p.content : 'missing';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toContain("The content.");
	});

	it("plan.create writes a file visible to subsequent plan.isExists", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  plan.create('New Plan', '# New Plan\\n\\nContent.');
  return plan.isExists('new-plan') ? 'yes' : 'no';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
		expect(planIsExists(tmpDir, "new-plan")).toBe(true);
	});

	it("plan functions work in an edge condition", () => {
		planCreate(tmpDir, "Ready Plan", "# Ready Plan\n\nDone.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => 'done'));
g.node('b', agent('worker', () => 'b'));
g.node('c', agent('worker', () => 'c'));
g.edge('a', (state, result) => plan.isExists('ready-plan') ? 'b' : 'c');
g.edge('b', END);
g.edge('c', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(conditionOf(graph, "a")({}, {} as any)).toBe("b");
	});
});

// ── contract sandbox object ───────────────────────────────────────────────────

describe("contract sandbox in graph script", () => {
	it("contract.isExists returns false for missing contract", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => contract.isExists('no-such') ? 'yes' : 'no'));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("no");
	});

	it("contract.isExists returns true after contractCreate", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API\n\nSpec." });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => contract.isExists('auth-api') ? 'yes' : 'no'));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
	});

	it("contract.length returns correct count", () => {
		contractCreate(tmpDir, { name: "API A", type: "api", producer: "architect", consumer: "worker", content: "# API A" });
		contractCreate(tmpDir, { name: "API B", type: "api", producer: "architect", consumer: "worker", content: "# API B" });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => String(contract.length())));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("2");
	});

	it("contract.indexOf finds by status", () => {
		contractCreate(tmpDir, { name: "Draft Contract", type: "api", producer: "architect", consumer: "worker", content: "# Draft" });
		contractCreate(tmpDir, { name: "Proposed Contract", type: "api", producer: "architect", consumer: "worker", content: "# Proposed" });
		contractPropose(tmpDir, "proposed-contract");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const found = contract.indexOf(c => c.status === 'proposed');
  return found ? found.id : 'none';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("proposed-contract");
	});

	it("contract.indexOf returns null when nothing matches", () => {
		contractCreate(tmpDir, { name: "Draft Only", type: "api", producer: "architect", consumer: "worker", content: "# Draft" });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const found = contract.indexOf(c => c.status === 'proposed');
  return found === null ? 'null' : 'found';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("null");
	});

	it("contract.get returns content in prompt function", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API\n\nEndpoints here." });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const c = contract.get('auth-api');
  return c.ok ? c.content : 'missing';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toContain("Endpoints here.");
	});

	it("contract functions work in an edge condition", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		contractPropose(tmpDir, "auth-api");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => 'done'));
g.node('ready', agent('worker', () => 'ready'));
g.node('wait', agent('worker', () => 'wait'));
g.edge('a', (state, result) => {
  const c = contract.get('auth-api');
  return (c.ok && c.content.includes('status: proposed')) ? 'ready' : 'wait';
});
g.edge('ready', END);
g.edge('wait', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(conditionOf(graph, "a")({}, {} as any)).toBe("ready");
	});

	it("contract.create writes a file visible to contract.isExists", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  contract.create({ name: 'New API', type: 'api', producer: 'architect', consumer: 'worker', content: '# New API' });
  return contract.isExists('new-api') ? 'yes' : 'no';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
		expect(contractIsExists(tmpDir, "new-api")).toBe(true);
	});
});

// ── both plan and contract together ──────────────────────────────────────────

describe("plan and contract together in one script", () => {
	it("both can be used in the same script", () => {
		planCreate(tmpDir, "Auth Plan", "# Auth Plan\n\nContent.");
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const hasplan = plan.isExists('auth-plan');
  const hasContract = contract.isExists('auth-api');
  return hasplan && hasContract ? 'both' : 'missing';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: {
				plan: makePlanSandboxForTest(tmpDir),
				contract: makeContractSandboxForTest(tmpDir),
			},
		});
		expect(promptFnOf(graph, "a")({})).toBe("both");
	});
});

// ── cwd isolation ─────────────────────────────────────────────────────────────

describe("cwd binding", () => {
	it("writes land in tmpDir, not cwd", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  plan.create('Isolated Plan', '# Isolated Plan\\n\\nContent.');
  return 'done';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		promptFnOf(graph, "a")({});
		expect(planIsExists(tmpDir, "isolated-plan")).toBe(true);
		expect(planIsExists(process.cwd(), "isolated-plan")).toBe(false);
	});
});
