/**
 * Tool availability — environment variable keys for communicating required
 * child tools and diagnostic paths to child processes.
 */

import * as fs from "node:fs";

export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = "PI_SUBAGENT_CHILD_TOOL_DIAGNOSTIC_PATH";
export const MCP_DIRECT_CHILD_TOOLS_ENV = "PI_SUBAGENT_MCP_DIRECT_CHILD_TOOLS";
export const REQUIRED_CHILD_TOOLS_ENV = "PI_SUBAGENT_REQUIRED_CHILD_TOOLS";

export interface ChildToolDiagnostic {
	available: string[];
	missing: string[];
}

export function writeChildToolDiagnostic(
	filePath: string,
	required: string[],
	available: string[],
	_agentName?: string,
	_mcpTools?: string[],
): ChildToolDiagnostic {
	const missing = required.filter((r) => !available.includes(r));
	const diagnostic: ChildToolDiagnostic = { available, missing };
	try {
		fs.writeFileSync(filePath, JSON.stringify(diagnostic));
	} catch {
		// Best effort
	}
	return diagnostic;
}

export function readChildToolDiagnosticError(toolDiagnosticPath: string | undefined): string | undefined {
	if (!toolDiagnosticPath) return undefined;
	try {
		const content = JSON.parse(fs.readFileSync(toolDiagnosticPath, "utf-8")) as ChildToolDiagnostic;
		if (content.missing.length > 0) {
			return `Missing required tools: ${content.missing.join(", ")}`;
		}
	} catch {
		// No diagnostic file or parse error — ignore
	}
	return undefined;
}
