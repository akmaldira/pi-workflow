/**
 * Agent catalog — makes the discovered agent roster visible to the model.
 *
 * Agent discovery has always worked, but nothing ever told the assistant
 * which agents exist. `/agents` renders to the human's screen, and the
 * workflow tool's guidelines never enumerated the roster. The model was
 * expected to name an agent it had never been shown, and resolveAgent()
 * silently fell back to a generic default when it guessed wrong — so the
 * failure was invisible.
 *
 * This module closes that loop two ways:
 *
 *   - a compact roster string injected into tool guidelines as ambient
 *     context, so the common case needs no tool call at all;
 *   - a `list_agents` tool for when the model wants the full detail.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig, AgentScope, AgentSource } from "./agents.ts";
import { discoverAgents } from "./agents.ts";

/** Ordering for display: builtins first, then user, then project. */
const SOURCE_RANK: Record<AgentSource, number> = { builtin: 0, user: 1, project: 2 };

export interface AgentCatalogEntry {
	name: string;
	description: string;
	source: AgentSource;
	tools?: string[];
	model?: string;
	acceptanceRole?: "read-only" | "writer";
	defaultContext?: "fresh" | "fork";
}

export function toCatalogEntry(agent: AgentConfig): AgentCatalogEntry {
	return {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		tools: agent.tools,
		model: agent.model,
		acceptanceRole: agent.acceptanceRole,
		defaultContext: agent.defaultContext,
	};
}

export function buildAgentCatalog(agents: AgentConfig[]): AgentCatalogEntry[] {
	return agents
		.map(toCatalogEntry)
		.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name));
}

/**
 * Truncates on a word boundary where possible, so a clipped description
 * does not end mid-word.
 */
function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;

	const clipped = collapsed.slice(0, max - 1);
	const lastSpace = clipped.lastIndexOf(" ");
	const body = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;
	return `${body.trimEnd()}…`;
}

export interface CatalogSummaryOptions {
	/** Max characters per description. Default 100. */
	maxDescriptionLength?: number;
	/**
	 * Max agents to list before summarising the remainder. Default 40.
	 * Guards against a huge roster crowding out the rest of the prompt.
	 */
	maxAgents?: number;
}

/**
 * Renders the roster as a compact one-line-per-agent block for injection
 * into tool guidelines.
 *
 * Kept terse on purpose: this rides along on every request, so it buys
 * name recognition and a rough sense of each role, not full documentation.
 * `list_agents` exists for the detail.
 */
export function buildAgentCatalogSummary(
	agents: AgentConfig[],
	options: CatalogSummaryOptions = {},
): string {
	const { maxDescriptionLength = 100, maxAgents = 40 } = options;
	const catalog = buildAgentCatalog(agents);

	if (catalog.length === 0) {
		return "No agents are currently available. Agent-based delegation will not work until agents are defined in .pi/agents/ or ~/.pi/agent/agents/.";
	}

	const shown = catalog.slice(0, maxAgents);
	const lines = shown.map((entry) => {
		const marks: string[] = [];
		if (entry.source !== "builtin") marks.push(entry.source);
		if (entry.acceptanceRole === "read-only") marks.push("read-only");
		const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
		return `- ${entry.name}${suffix}: ${truncate(entry.description, maxDescriptionLength)}`;
	});

	const remainder = catalog.length - shown.length;
	if (remainder > 0) {
		lines.push(`- …and ${remainder} more; call list_agents for the full roster.`);
	}

	return [`Available agents (${catalog.length}):`, ...lines].join("\n");
}

/**
 * The guideline string handed to tools that take an agent name.
 *
 * States the roster and the constraint that names must come from it. The
 * silent-fallback behaviour of resolveAgent() means a hallucinated name
 * does not error — it quietly runs the wrong agent — so the instruction to
 * stay inside the list carries real weight.
 */
export function buildAgentCatalogGuideline(
	agents: AgentConfig[],
	options: CatalogSummaryOptions = {},
): string {
	return [
		buildAgentCatalogSummary(agents, options),
		"Use one of these exact names when delegating. Do not invent agent names: an unrecognised name silently falls back to a generic agent rather than failing, so the mistake is easy to miss.",
	].join("\n");
}

const ListAgentsParams = Type.Object({
	scope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description:
				"Which authored agents to include. Agents bundled with the package are always listed. Default: both.",
		}),
	),
	detailed: Type.Optional(
		Type.Boolean({
			description:
				"Include tools, model, acceptance role, and context mode for each agent. Default: false.",
		}),
	),
});

function formatDetailed(entry: AgentCatalogEntry): string {
	const parts = [`- ${entry.name} (${entry.source}): ${entry.description}`];
	const attrs: string[] = [];
	if (entry.tools?.length) attrs.push(`tools: ${entry.tools.join(", ")}`);
	if (entry.model) attrs.push(`model: ${entry.model}`);
	if (entry.acceptanceRole) attrs.push(`role: ${entry.acceptanceRole}`);
	if (entry.defaultContext) attrs.push(`context: ${entry.defaultContext}`);
	if (attrs.length > 0) parts.push(`    ${attrs.join(" | ")}`);
	return parts.join("\n");
}

export function createListAgentsTool(): ToolDefinition {
	return defineTool({
		name: "list_agents",
		label: "List Agents",
		description:
			"List the agents available for delegation, with their descriptions. Use this before delegating when unsure which agent fits, or to check whether a specialised agent exists for a task.",
		promptSnippet: "List available subagents and what each one is for.",
		parameters: ListAgentsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope: AgentScope = params.scope ?? "both";
			const { agents } = discoverAgents(ctx.cwd, scope);
			const catalog = buildAgentCatalog(agents);

			if (catalog.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No agents available. Define agents in .pi/agents/ (project) or ~/.pi/agent/agents/ (user).",
						},
					],
					details: { count: 0, agents: [] },
				};
			}

			const body = params.detailed
				? catalog.map(formatDetailed).join("\n")
				: catalog.map((e) => `- ${e.name} (${e.source}): ${e.description}`).join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `${catalog.length} agent${catalog.length === 1 ? "" : "s"} available:\n${body}`,
					},
				],
				details: { count: catalog.length, agents: catalog },
			};
		},
	});
}
