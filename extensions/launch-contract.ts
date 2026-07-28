/**
 * Launch contract — generates cryptographic digests of agent configuration
 * and launch parameters for caching and verification.
 */

import { createHash } from "node:crypto";
import type { AgentConfig } from "./agents.ts";

export function agentDefinitionDigest(agent: AgentConfig): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify({
		name: agent.name,
		description: agent.description,
		model: agent.model,
		fallbackModels: agent.fallbackModels,
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		systemPrompt: agent.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: agent.skills,
		skillPath: agent.skillPath,
		thinking: agent.thinking,
		completionGuard: agent.completionGuard,
		memory: agent.memory,
	}));
	return hash.digest("hex").slice(0, 16);
}

export function launchBindingDigest(params: {
	definitionDigest: string;
	task: string;
	model?: string;
	modelCandidates?: string[];
	thinking?: string;
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills: string[];
	tools: string[];
	extensions: string[];
	mcpDirectTools: string[];
	outputPath?: string;
	outputMode: "inline" | "file-only";
	structuredOutputSchema?: unknown;
}): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify(params));
	return hash.digest("hex").slice(0, 16);
}
