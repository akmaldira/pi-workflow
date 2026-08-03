/**
 * Integration tests for context: "fork" resolution inside execution.ts's
 * buildSystemPrompt(). Verifies fork mode injects a summary, fresh mode does
 * not, and missing/failing forkContext falls back gracefully without
 * throwing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	return {
		generateSummaryWithUsage: vi.fn(),
		sessionEntryToContextMessages: vi.fn((entry: any) => {
			if (entry.type !== "message") return [];
			return [entry.message];
		}),
	};
});

import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "../extensions/execution.ts";
import { clearForkSummaryCache } from "../extensions/fork-context.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunSyncOptions } from "../extensions/types.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

function makeSessionManager(entries: unknown[] = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
]) {
	return {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp/sessions",
		getSessionId: () => "session-1",
		getSessionFile: () => "/tmp/sessions/session-1.jsonl",
		getLeafId: () => "leaf-1",
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getHeader: () => null,
		getEntries: () => entries,
		getTree: () => [],
		getSessionName: () => undefined,
	} as any;
}

function makeModelRegistry() {
	return {
		find: vi.fn(),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key", headers: {}, env: {} })),
	};
}

describe("execution.ts buildSystemPrompt — context resolution", () => {
	beforeEach(() => {
		clearForkSummaryCache();
		vi.mocked(generateSummaryWithUsage).mockReset();
	});

	afterEach(() => {
		clearForkSummaryCache();
	});

	it("defaults to fork mode when context is unspecified and forkContext is available", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({
			text: "## Goal\nDefault fork summary.",
			usage: {} as any,
		});
		const agent = makeAgent();
		const options: RunSyncOptions = {
			runId: "test-run",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toContain("## Goal\nDefault fork summary.");
		expect(notes).toHaveLength(0);
		expect(generateSummaryWithUsage).toHaveBeenCalledTimes(1);
	});

	it("defaults to fork mode but falls back gracefully when no forkContext is available", async () => {
		const agent = makeAgent();
		const options: RunSyncOptions = { runId: "test-run" };
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("no parent session handles were available");
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("explicit fresh context does not inject any fork summary", async () => {
		const agent = makeAgent();
		const options: RunSyncOptions = { runId: "test-run", context: "fresh" };
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(0);
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("fork mode with forkContext injects the structured summary", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({
			text: "## Goal\nContinue the parent's work.",
			usage: {} as any,
		});
		const agent = makeAgent();
		const options: RunSyncOptions = {
			runId: "test-run",
			context: "fork",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt, notes, parentSessionFile } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toContain("You are a worker.");
		expect(prompt).toContain("## Parent session context (summary)");
		expect(prompt).toContain("## Goal\nContinue the parent's work.");
		expect(notes).toHaveLength(0);
		expect(parentSessionFile).toBe("/tmp/sessions/session-1.jsonl");
	});

	it("fork mode falls back to fresh with a note when forkContext is missing", async () => {
		const agent = makeAgent();
		const options: RunSyncOptions = { runId: "test-run", context: "fork" };
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("no parent session handles were available");
	});

	it("fork mode falls back to fresh with a note when summarization fails", async () => {
		vi.mocked(generateSummaryWithUsage).mockRejectedValue(new Error("boom"));
		const agent = makeAgent();
		const options: RunSyncOptions = {
			runId: "test-run",
			context: "fork",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("could not be generated");
	});

	it("uses agent.defaultContext when options.context is unset", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({
			text: "## Goal\nFrom frontmatter default.",
			usage: {} as any,
		});
		const agent = makeAgent({ defaultContext: "fork" });
		const options: RunSyncOptions = {
			runId: "test-run",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toContain("## Goal\nFrom frontmatter default.");
	});

	it("explicit options.context overrides agent.defaultContext", async () => {
		const agent = makeAgent({ defaultContext: "fork" });
		const options: RunSyncOptions = {
			runId: "test-run",
			context: "fresh",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(0);
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("agent.defaultContext: 'fresh' overrides the global fork default", async () => {
		const agent = makeAgent({ defaultContext: "fresh" });
		const options: RunSyncOptions = {
			runId: "test-run",
			forkContext: {
				sessionManager: makeSessionManager(),
				modelRegistry: makeModelRegistry(),
				fallbackModel: { provider: "test", id: "test-model" } as any,
			},
		};
		const { prompt, notes } = await buildSystemPrompt(agent, "/tmp", options);
		expect(prompt).toBe("You are a worker.");
		expect(notes).toHaveLength(0);
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});
});
