/**
 * Utility functions for subagent execution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function findLatestSessionFile(sessionDir: string): string | undefined {
	try {
		const files = fs.readdirSync(sessionDir).filter((f: string) => f.endsWith(".json"));
		if (files.length === 0) return undefined;
		files.sort().reverse();
		return path.join(sessionDir, files[0]);
	} catch {
		return undefined;
	}
}

export function detectSubagentError(stderr: string): string | undefined {
	if (stderr.includes("error") || stderr.includes("Error")) {
		return stderr.trim();
	}
	return undefined;
}

export function hasEmptyTerminalAssistantResponse(messages: Message[] | undefined): boolean {
	if (!messages?.length) return true;
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return true;
	for (const part of last.content) {
		if (part.type === "text" && part.text.trim()) return false;
	}
	return true;
}

export function extractToolArgsPreview(event: { args?: unknown }): string {
	if (event.args) {
		const args = typeof event.args === "string" ? event.args : JSON.stringify(event.args);
		return args.length > 200 ? args.slice(0, 200) + "..." : args;
	}
	return "";
}

/**
 * One-line "what is this subagent doing right now" summary, built from an
 * AgentProgress snapshot. Used to show live status in the main agent's chat
 * panel while a subagent tool call is still running — the same information
 * /workflows shows in full, condensed to a single line.
 */
export function formatProgressLine(progress: {
	currentTool?: string;
	currentToolArgs?: string;
	turnCount?: number;
	toolCount: number;
	tokens: number;
}): string {
	if (progress.currentTool) {
		const rawArgs = progress.currentToolArgs ?? "";
		const args = rawArgs.length > 60 ? `${rawArgs.slice(0, 60)}…` : rawArgs;
		return `→ ${progress.currentTool}${args ? ` ${args}` : ""}`;
	}
	if (progress.toolCount > 0) return `thinking… (${progress.toolCount} tool call${progress.toolCount === 1 ? "" : "s"} so far)`;
	return "starting…";
}

export function extractTextFromContent(message: Message): string[] {
	if (!message.content) return [];
	if (typeof message.content === "string") return [message.content];
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text?: string }).text || "");
	}
	return [];
}
