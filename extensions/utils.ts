/**
 * Utility functions for subagent execution.
 */

import type { Message } from "@earendil-works/pi-ai";

export function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function findLatestSessionFile(sessionDir: string): string | undefined {
	try {
		const files = require("node:fs").readdirSync(sessionDir).filter((f: string) => f.endsWith(".json"));
		if (files.length === 0) return undefined;
		files.sort().reverse();
		return require("node:path").join(sessionDir, files[0]);
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

export function extractToolArgsPreview(event: any): string {
	if (event.args) {
		const args = typeof event.args === "string" ? event.args : JSON.stringify(event.args);
		return args.length > 200 ? args.slice(0, 200) + "..." : args;
	}
	return "";
}

export function extractTextFromContent(message: Message): string[] {
	if (!message.content) return [];
	if (typeof message.content === "string") return [message.content];
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as any).text || "");
	}
	return [];
}
