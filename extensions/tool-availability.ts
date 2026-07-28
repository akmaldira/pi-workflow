/**
 * Tool availability — environment variable keys for communicating required
 * child tools and diagnostic paths to child processes.
 */

export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = "PI_SUBAGENT_CHILD_TOOL_DIAGNOSTIC_PATH";
export const MCP_DIRECT_CHILD_TOOLS_ENV = "PI_SUBAGENT_MCP_DIRECT_CHILD_TOOLS";
export const REQUIRED_CHILD_TOOLS_ENV = "PI_SUBAGENT_REQUIRED_CHILD_TOOLS";

export interface ToolDiagnosticInfo {
	available: string[];
	missing: string[];
}

export function readChildToolDiagnosticError(toolDiagnosticPath: string | undefined): string | undefined {
	if (!toolDiagnosticPath) return undefined;
	try {
		const content = JSON.parse(fs.readFileSync(toolDiagnosticPath, "utf-8")) as ToolDiagnosticInfo;
		if (content.missing.length > 0) {
			return `Missing required tools: ${content.missing.join(", ")}`;
		}
	} catch {
		// No diagnostic file or parse error — ignore
	}
	return undefined;
}

import * as fs from "node:fs";
