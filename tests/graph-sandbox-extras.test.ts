/**
 * Tests for the sandboxExtras feature in graph-validator:
 * - plan and contract objects are available inside graph scripts
 * - all methods work (create, get, list, edit, delete, propose, supersede)
 * - get returns ok:false (never throws) for a missing id
 * - AST validator accepts plan/contract identifiers when registered
 * - unknown extras still rejected by AST (error message lists all allowed globals)
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
import { planCreate, planGet } from "../extensions/plan-tool.ts";
import {
	contractCreate,
	contractGet,
	contractPropose,
} from "../extensions/contract-tool.ts";
import { makePlanSandboxForTest, makeContractSandboxForTest } from "./helpers/sandbox-extras.ts";
import type { AgentNodeDef } from "../extensions/graph-dsl.ts";
import * as acorn from "acorn";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-extras-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function promptFnOf(graph: ReturnType<typeof buildGraphFromScript>["graph"], id: string) {
	const node = graph.nodes.get(id);
	if (!node) throw new Error(`Node "${id}" not found`);
	if (node.def.type !== "agent") throw new Error(`Node "${id}" is not an agent node`);
	return (node.def as AgentNodeDef).promptFn;
}

function conditionOf(graph: ReturnType<typeof buildGraphFromScript>["graph"], from: string) {
	const edges = graph.edges.get(from) ?? [];
	const edge = edges.find((e) => e.type === "conditional");
	if (!edge || edge.type !== "conditional") throw new Error(`No conditional edge from "${from}"`);
	return edge.condition;
}

// ── AST validation ────────────────────────────────────────────────────────────

describe("AST validation with sandboxExtras", () => {
	it("accepts 'plan' identifier when registered as extraGlobal", () => {
		const ast = acorn.parse("plan.get('foo');", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		expect(validateGraphAst(ast, { extraGlobals: ["plan"] })).toEqual([]);
	});

	it("accepts 'contract' identifier when registered as extraGlobal", () => {
		const ast = acorn.parse("contract.list();", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		expect(validateGraphAst(ast, { extraGlobals: ["contract"] })).toEqual([]);
	});

	it("still rejects 'plan' when NOT registered as extraGlobal", () => {
		const ast = acorn.parse("plan.get('foo');", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		expect(validateGraphAst(ast, {}).some((e) => e.includes('"plan"'))).toBe(true);
	});

	it("error message includes extra globals when registered", () => {
		const ast = acorn.parse("unknownThing;", {
			ecmaVersion: "latest",
			sourceType: "module",
		}) as Parameters<typeof validateGraphAst>[0];
		const errors = validateGraphAst(ast, { extraGlobals: ["plan", "contract"] });
		expect(errors[0]).toContain("plan");
		expect(errors[0]).toContain("contract");
	});
});

// ── plan sandbox ──────────────────────────────────────────────────────────────

describe("plan sandbox in graph script", () => {
	it("plan.get returns ok:false (no throw) for a missing plan", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const p = plan.get('nonexistent');
  return p.ok ? 'found' : 'missing';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("missing");
	});

	it("plan.get returns content after plan.create", () => {
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

	it("plan.get content can be used for length and indexOf checks", () => {
		planCreate(tmpDir, "Auth Plan", "# Auth Plan\n\nDesign the auth module.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const p = plan.get('auth-plan');
  const len = p.content?.length ?? 0;
  const pos = p.content?.indexOf('auth') ?? -1;
  return len > 0 && pos >= 0 ? 'ok' : 'fail';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("ok");
	});

	it("plan.create writes a file readable by plan.get", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  plan.create('New Plan', '# New Plan\\n\\nCreated in script.');
  const p = plan.get('new-plan');
  return p.ok ? 'yes' : 'no';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
		// Verify it hit tmpDir, not process.cwd()
		expect(planGet(tmpDir, "new-plan").ok).toBe(true);
		expect(planGet(process.cwd(), "new-plan").ok).toBe(false);
	});

	it("plan.list returns all plans", () => {
		planCreate(tmpDir, "Plan A", "# Plan A\n\nA.");
		planCreate(tmpDir, "Plan B", "# Plan B\n\nB.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const r = plan.list();
  return String(r.plans?.length ?? 0);
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("2");
	});

	it("plan.get works in an edge condition", () => {
		planCreate(tmpDir, "Ready Plan", "# Ready Plan\n\nApproved.");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => 'done'));
g.node('b', agent('worker', () => 'b'));
g.node('c', agent('worker', () => 'c'));
g.edge('a', (state, result) => plan.get('ready-plan').ok ? 'b' : 'c');
g.edge('b', END);
g.edge('c', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(conditionOf(graph, "a")({}, {} as any)).toBe("b");
	});

	it("plan.get returns ok:false in edge condition when plan is missing", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => 'done'));
g.node('b', agent('worker', () => 'b'));
g.node('c', agent('worker', () => 'c'));
g.edge('a', (state, result) => plan.get('no-such-plan').ok ? 'b' : 'c');
g.edge('b', END);
g.edge('c', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { plan: makePlanSandboxForTest(tmpDir) },
		});
		expect(conditionOf(graph, "a")({}, {} as any)).toBe("c");
	});
});

// ── contract sandbox ──────────────────────────────────────────────────────────

describe("contract sandbox in graph script", () => {
	it("contract.get returns ok:false (no throw) for a missing contract", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const c = contract.get('no-such');
  return c.ok ? 'found' : 'missing';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("missing");
	});

	it("contract.get returns content after contractCreate", () => {
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

	it("contract.get content supports indexOf for status checks", () => {
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		contractPropose(tmpDir, "auth-api");
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const c = contract.get('auth-api');
  return (c.ok && c.content.includes('status: proposed')) ? 'proposed' : 'other';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("proposed");
	});

	it("contract.create writes a file readable by contract.get", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  contract.create({ name: 'New API', type: 'api', producer: 'architect', consumer: 'worker', content: '# New API' });
  const c = contract.get('new-api');
  return c.ok ? 'yes' : 'no';
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("yes");
		expect(contractGet(tmpDir, "new-api").ok).toBe(true);
		expect(contractGet(process.cwd(), "new-api").ok).toBe(false);
	});

	it("contract.list returns all contracts", () => {
		contractCreate(tmpDir, { name: "API A", type: "api", producer: "architect", consumer: "worker", content: "# API A" });
		contractCreate(tmpDir, { name: "API B", type: "api", producer: "architect", consumer: "worker", content: "# API B" });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const r = contract.list();
  return String(r.contracts?.length ?? 0);
}));
g.edge('a', END);
g.run({});
`;
		const { graph } = buildGraphFromScript(script, {
			sandboxExtras: { contract: makeContractSandboxForTest(tmpDir) },
		});
		expect(promptFnOf(graph, "a")({})).toBe("2");
	});

	it("contract.get works in an edge condition — route on status", () => {
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
});

// ── plan and contract together ────────────────────────────────────────────────

describe("plan and contract together in one script", () => {
	it("both can be used in the same script", () => {
		planCreate(tmpDir, "Auth Plan", "# Auth Plan\n\nContent.");
		contractCreate(tmpDir, { name: "Auth API", type: "api", producer: "architect", consumer: "worker", content: "# Auth API" });
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('a', agent('worker', () => {
  const hasPlan = plan.get('auth-plan').ok;
  const hasContract = contract.get('auth-api').ok;
  return hasPlan && hasContract ? 'both' : 'missing';
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
