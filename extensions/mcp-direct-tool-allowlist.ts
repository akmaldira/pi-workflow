/**
 * MCP direct tool allowlist resolution — resolves which MCP tools should be
 * made available to child subagents based on configuration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedMcpDirectToolSelection {
	name: string;
	selector: string;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

export function resolveMcpDirectToolSelections(mcpDirectTools: string[] | undefined, cwd = process.cwd()): ResolvedMcpDirectToolSelection[] {
	if (!mcpDirectTools?.length) return [];

	try {
		const config = loadMcpConfig(cwd);
		const cache = loadMetadataCache();
		if (!cache) return [];
		return resolveDirectToolSelections(config, cache, "server", mcpDirectTools);
	} catch {
		return [];
	}
}

function loadMetadataCache(): { servers: Record<string, { configHash?: string; tools?: Array<{ name?: string }>; cachedAt?: number }> } | null {
	const cachePath = path.join(os.homedir(), ".pi", "agent", "mcp-cache.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== 1 || !raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) return null;
	return raw as unknown as ReturnType<typeof loadMetadataCache>;
}

function loadMcpConfig(cwd: string): { mcpServers: Record<string, unknown> } {
	const sources: string[] = [];
	const piGlobalPath = path.join(os.homedir(), ".pi", "agent", "mcp.json");
	const projectPath = path.resolve(cwd, ".mcp.json");
	sources.push(piGlobalPath, projectPath);

	let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
	for (const sourcePath of sources) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const obj = parsed as Record<string, unknown>;
		const servers = obj.mcpServers;
		if (servers && typeof servers === "object" && !Array.isArray(servers)) {
			config = { mcpServers: { ...config.mcpServers, ...(servers as Record<string, unknown>) } };
		}
	}
	return config;
}

function resolveDirectToolSelections(
	config: { mcpServers: Record<string, unknown> },
	cache: ReturnType<typeof loadMetadataCache>,
	prefix: string,
	envOverride: string[],
): ResolvedMcpDirectToolSelection[] {
	const names: ResolvedMcpDirectToolSelection[] = [];
	const seenNames = new Set<string>();
	const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache?.servers?.[serverName];
		if (!serverCache?.tools) continue;

		const toolFilter = selectedServers.has(serverName)
			? true
			: selectedTools.get(serverName);
		if (!toolFilter) continue;

		for (const tool of serverCache.tools) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			const prefixedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${tool.name}` });
		}
	}

	return names;
}

function parseSelections(selections: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (let item of selections) {
		item = item.replace(/\/+$/, "");
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				if (!tools.has(server)) tools.set(server, new Set());
				tools.get(server)!.add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

function formatToolName(toolName: string, serverName: string, prefix: string): string {
	if (prefix === "none") return toolName;
	const serverPrefix = serverName.replace(/-/g, "_");
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

export function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd = process.cwd()): string[] {
	return resolveMcpDirectToolSelections(mcpDirectTools, cwd).map((selection) => selection.name);
}
