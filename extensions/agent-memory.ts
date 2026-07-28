/**
 * Agent memory injection — reads MEMORY.md files and injects them into the
 * system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentMemoryConfig {
	scope: "project" | "user";
	path: string;
}

export async function buildAgentMemoryInjection(memory: AgentMemoryConfig, cwd: string): Promise<string | undefined> {
	let memoryPath: string;
	if (memory.scope === "user") {
		memoryPath = path.resolve(process.env.HOME || process.env.USERPROFILE || "~", memory.path);
	} else {
		memoryPath = path.resolve(cwd, memory.path);
	}

	try {
		const content = fs.readFileSync(memoryPath, "utf-8");
		if (!content.trim()) return undefined;
		return `## Agent Memory\n\n${content}`;
	} catch {
		// Memory file doesn't exist or isn't readable — that's OK
		return undefined;
	}
}
