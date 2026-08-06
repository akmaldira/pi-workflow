import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS_DIR, discoverAgents } from "../extensions/agents.ts";

const EXPECTED_BUILTINS = [
	"planner",
	"architect",
	"monitor",
	"red",
	"green",
	"reviewer",
	"researcher",
	"scout",
	"worker",
];

describe("bundled agents", () => {
	it("resolves BUILTIN_AGENTS_DIR to a real directory inside the package", () => {
		expect(fs.existsSync(BUILTIN_AGENTS_DIR)).toBe(true);
		expect(fs.statSync(BUILTIN_AGENTS_DIR).isDirectory()).toBe(true);
		expect(path.basename(BUILTIN_AGENTS_DIR)).toBe("bundled-agents");
	});

	it("ships all expected roles, each parsed with source 'builtin'", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project");
		const byName = new Map(agents.map((a) => [a.name, a]));

		for (const name of EXPECTED_BUILTINS) {
			const agent = byName.get(name);
			expect(agent, `missing bundled agent: ${name}`).toBeDefined();
			expect(agent!.source).toBe("builtin");
			expect(agent!.description.length).toBeGreaterThan(0);
			expect(agent!.systemPrompt.length).toBeGreaterThan(100);
		}
	});

	it("parses frontmatter fields on bundled agents correctly", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project");
		const green = agents.find((a) => a.name === "green")!;

		expect(green.tools).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
		expect(green.defaultContext).toBe("fork");
		expect(green.acceptanceRole).toBe("writer");
		// Regression: inline-map frontmatter must decode to an object, not throw.
		expect(green.turnBudget).toEqual({ maxTurns: 25, graceTurns: 4 });
		expect(green.acceptance).toEqual({ level: "checked" });
	});

	it("gives read-only roles no write tools", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project");
		const readOnly = ["planner", "architect", "monitor", "reviewer", "researcher", "scout"];

		for (const name of readOnly) {
			const agent = agents.find((a) => a.name === name)!;
			expect(agent.acceptanceRole, name).toBe("read-only");
			expect(agent.tools, name).not.toContain("write");
			expect(agent.tools, name).not.toContain("edit");
		}
	});

	it("teaches escalation to every agent that can get stuck", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project");
		// Scout is deliberately excluded: it is a cheap locator with nothing to
		// escalate about.
		const mustEscalate = ["planner", "architect", "red", "green", "researcher", "worker"];

		for (const name of mustEscalate) {
			const agent = agents.find((a) => a.name === name)!;
			expect(agent.systemPrompt, name).toContain("STATUS: blocked");
			expect(agent.systemPrompt, name).toContain("BLOCKED_ON");
		}
	});

	it("forbids the shortcut failure modes in implementation agents", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project");

		for (const name of ["green", "worker"]) {
			const prompt = agents.find((a) => a.name === name)!.systemPrompt.toLowerCase();
			expect(prompt, name).toContain("mock");
			expect(prompt, name).toContain("weaken");
		}
	});

	it("can be excluded via includeBuiltins: false", () => {
		const { agents } = discoverAgents("/nonexistent-project", "project", {
			includeBuiltins: false,
		});
		expect(agents).toHaveLength(0);
	});
});

describe("agent source precedence", () => {
	let tempDir: string;
	let builtinDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-precedence-"));
		builtinDir = path.join(tempDir, "fake-builtins");
		fs.mkdirSync(builtinDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeAgent(dir: string, name: string, description: string): void {
		fs.writeFileSync(
			path.join(dir, `${name}.md`),
			`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody for ${name}, long enough to be a real prompt body.\n`,
		);
	}

	it("loads builtins when no project agent shadows them", () => {
		writeAgent(builtinDir, "planner", "builtin planner");

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });
		const planner = agents.find((a) => a.name === "planner")!;

		expect(planner.description).toBe("builtin planner");
		expect(planner.source).toBe("builtin");
	});

	it("lets a project agent shadow a builtin of the same name", () => {
		writeAgent(builtinDir, "planner", "builtin planner");
		writeAgent(path.join(tempDir, ".pi", "agents"), "planner", "project planner");

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });
		const planners = agents.filter((a) => a.name === "planner");

		// Shadowed, not duplicated.
		expect(planners).toHaveLength(1);
		expect(planners[0].description).toBe("project planner");
		expect(planners[0].source).toBe("project");
	});

	it("merges builtins and project agents rather than replacing the set", () => {
		writeAgent(builtinDir, "planner", "builtin planner");
		writeAgent(builtinDir, "green", "builtin green");
		writeAgent(path.join(tempDir, ".pi", "agents"), "custom", "project custom");

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });
		const names = agents.map((a) => a.name).sort();

		expect(names).toEqual(["custom", "green", "planner"]);
	});

	it("still exposes builtins when scope is 'user'", () => {
		writeAgent(builtinDir, "planner", "builtin planner");

		const { agents } = discoverAgents(tempDir, "user", { builtinDir });

		expect(agents.some((a) => a.name === "planner" && a.source === "builtin")).toBe(true);
	});

	it("ignores a missing builtin directory without throwing", () => {
		const { agents } = discoverAgents(tempDir, "project", {
			builtinDir: path.join(tempDir, "does-not-exist"),
		});
		expect(agents).toHaveLength(0);
	});
});
