import { describe, expect, it } from "vitest";
import {
	buildAgentCatalog,
	buildAgentCatalogGuideline,
	buildAgentCatalogSummary,
	createListAgentsTool,
	toCatalogEntry,
} from "../extensions/agent-catalog.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} does things`,
		systemPrompt: `# ${name}`,
		source: "builtin",
		filePath: `/fake/${name}.md`,
		...overrides,
	};
}

describe("toCatalogEntry", () => {
	it("projects the fields the model needs and drops the rest", () => {
		const entry = toCatalogEntry(
			makeAgent("green", {
				tools: ["read", "write"],
				model: "opus",
				acceptanceRole: "writer",
				defaultContext: "fork",
				systemPrompt: "a very long system prompt that must not be included",
			}),
		);

		expect(entry).toEqual({
			name: "green",
			description: "green does things",
			source: "builtin",
			tools: ["read", "write"],
			model: "opus",
			acceptanceRole: "writer",
			defaultContext: "fork",
		});
		expect(entry).not.toHaveProperty("systemPrompt");
		expect(entry).not.toHaveProperty("filePath");
	});
});

describe("buildAgentCatalog", () => {
	it("sorts builtins first, then user, then project, alphabetically within each", () => {
		const catalog = buildAgentCatalog([
			makeAgent("zeta", { source: "project" }),
			makeAgent("beta", { source: "user" }),
			makeAgent("alpha", { source: "project" }),
			makeAgent("worker"),
			makeAgent("architect"),
		]);

		expect(catalog.map((e) => e.name)).toEqual(["architect", "worker", "beta", "alpha", "zeta"]);
	});

	it("returns an empty array for an empty roster", () => {
		expect(buildAgentCatalog([])).toEqual([]);
	});
});

describe("buildAgentCatalogSummary", () => {
	it("lists every agent with its description", () => {
		const summary = buildAgentCatalogSummary([
			makeAgent("planner", { description: "Decomposes a task into a plan" }),
			makeAgent("green", { description: "Implements until tests pass" }),
		]);

		expect(summary).toContain("Available agents (2):");
		expect(summary).toContain("- planner: Decomposes a task into a plan");
		expect(summary).toContain("- green: Implements until tests pass");
	});

	it("marks non-builtin sources but leaves builtins unmarked", () => {
		const summary = buildAgentCatalogSummary([
			makeAgent("planner"),
			makeAgent("custom", { source: "project" }),
			makeAgent("mine", { source: "user" }),
		]);

		expect(summary).toContain("- planner: ");
		expect(summary).toContain("- custom [project]:");
		expect(summary).toContain("- mine [user]:");
	});

	it("marks read-only agents so the model knows they cannot implement", () => {
		const summary = buildAgentCatalogSummary([
			makeAgent("reviewer", { acceptanceRole: "read-only" }),
			makeAgent("green", { acceptanceRole: "writer" }),
		]);

		expect(summary).toContain("- reviewer [read-only]:");
		expect(summary).toContain("- green: ");
	});

	it("combines source and role marks", () => {
		const summary = buildAgentCatalogSummary([
			makeAgent("audit", { source: "project", acceptanceRole: "read-only" }),
		]);

		expect(summary).toContain("- audit [project, read-only]:");
	});

	it("truncates long descriptions on a word boundary", () => {
		const summary = buildAgentCatalogSummary(
			[makeAgent("verbose", { description: "word ".repeat(80).trim() })],
			{ maxDescriptionLength: 40 },
		);

		const line = summary.split("\n").find((l) => l.startsWith("- verbose"))!;
		expect(line.length).toBeLessThan(70);
		expect(line).toContain("…");
		expect(line).not.toContain("wor…");
	});

	it("collapses whitespace so multi-line descriptions stay on one line", () => {
		const summary = buildAgentCatalogSummary([
			makeAgent("multi", { description: "first line\n\n  second line" }),
		]);

		expect(summary).toContain("- multi: first line second line");
	});

	it("caps the roster and reports the remainder", () => {
		const agents = Array.from({ length: 50 }, (_, i) =>
			makeAgent(`agent${String(i).padStart(2, "0")}`),
		);

		const summary = buildAgentCatalogSummary(agents, { maxAgents: 10 });

		expect(summary).toContain("Available agents (50):");
		expect(summary).toContain("…and 40 more; call list_agents for the full roster.");
		expect(summary).not.toContain("agent20");
	});

	it("explains the situation when no agents exist", () => {
		const summary = buildAgentCatalogSummary([]);

		expect(summary).toContain("No agents are currently available");
		expect(summary).toContain(".pi/agents/");
	});
});

describe("buildAgentCatalogGuideline", () => {
	it("includes the roster and warns against inventing names", () => {
		const guideline = buildAgentCatalogGuideline([makeAgent("planner")]);

		expect(guideline).toContain("- planner:");
		expect(guideline).toContain("Do not invent agent names");
		// The silent-fallback behaviour is the reason the rule matters, so it
		// must be stated rather than left as an unexplained prohibition.
		expect(guideline).toContain("silently falls back");
	});
});

describe("list_agents tool", () => {
	const tool = createListAgentsTool();

	function ctx(cwd: string) {
		return { cwd } as never;
	}

	/**
	 * Reads the text the model actually receives.
	 *
	 * Asserting on a convenience field instead of `content` once let a tool
	 * ship that returned its payload only in a field pi never forwards: the
	 * unit tests passed while the model saw an empty result.
	 */
	function modelVisibleText(result: unknown): string {
		const content = (result as { content?: { type: string; text?: string }[] }).content;
		expect(content, "tool result must carry a content array").toBeDefined();
		return content!
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	}

	it("is registered under a stable name", () => {
		expect(tool.name).toBe("list_agents");
	});

	it("lists the bundled roster for a project with no agents of its own", async () => {
		const result = await tool.execute("id", {}, new AbortController().signal, () => {}, ctx("/nonexistent"));
		const text = modelVisibleText(result);

		expect(text).toContain("agents available:");
		expect(text).toContain("- planner (builtin):");
		expect(text).toContain("- green (builtin):");
		expect((result.details as { count: number }).count).toBeGreaterThanOrEqual(9);
	});

	it("delivers a non-empty payload to the model, not just to details", async () => {
		const result = await tool.execute("id", {}, new AbortController().signal, () => {}, ctx("/nonexistent"));

		expect(modelVisibleText(result).length).toBeGreaterThan(50);
	});

	it("omits attribute detail unless asked", async () => {
		const result = await tool.execute("id", {}, new AbortController().signal, () => {}, ctx("/nonexistent"));

		expect(modelVisibleText(result)).not.toContain("tools:");
	});

	it("includes attribute detail when detailed is set", async () => {
		const result = await tool.execute(
			"id",
			{ detailed: true },
			new AbortController().signal,
			() => {},
			ctx("/nonexistent"),
		);
		const text = modelVisibleText(result);

		expect(text).toContain("tools:");
		expect(text).toContain("role:");
	});

	it("returns structured details alongside the text content", async () => {
		const result = await tool.execute("id", {}, new AbortController().signal, () => {}, ctx("/nonexistent"));
		const details = result.details as { count: number; agents: { name: string }[] };

		expect(details.agents.length).toBe(details.count);
		expect(details.agents.some((a) => a.name === "architect")).toBe(true);
	});
});
