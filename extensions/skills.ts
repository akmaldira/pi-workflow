/**
 * Skills injection — builds system prompt additions for skill availability.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export async function buildSkillInjection(skills: string[], cwd: string): Promise<string | undefined> {
	if (!skills.length) return undefined;
	const lines: string[] = ["## Available Skills"];
	for (const skill of skills) {
		lines.push(`- ${skill}`);
	}
	return lines.join("\n");
}

export async function resolveSkillsWithFallback(
	skills: string[] | undefined,
	cwd: string,
): Promise<{ skills: string[] | undefined; warning?: string }> {
	if (!skills?.length) return { skills: undefined };
	return { skills };
}
