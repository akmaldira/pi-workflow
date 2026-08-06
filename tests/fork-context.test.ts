/**
 * Tests for fork-context.ts — compaction-style summary generation for
 * `context: "fork"` subagents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	return {
		generateSummaryWithUsage: vi.fn(),
		sessionEntryToContextMessages: vi.fn((entry: { type: string; message?: unknown }) => {
			if (entry.type !== "message") return [];
			return [entry.message];
		}),
	};
});

import type { Model, Api } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { generateForkSummary, formatForkContextBlock, clearForkSummaryCache } from "../extensions/fork-context.ts";
import type { ReadonlySessionManager } from "../extensions/types.ts";

/** Minimal fake Model<Api> — only the fields fork-context.ts actually reads. */
function makeFallbackModel(): Model<Api> {
	return { provider: "test", id: "test-model" } as unknown as Model<Api>;
}

/** Minimal fake token usage for generateSummaryWithUsage mock results. */
function makeUsage(overrides: Partial<Record<string, number>> = {}) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function makeSessionManager(overrides: Partial<{
	entries: unknown[];
	leafId: string | null;
	sessionId: string;
	sessionFile: string | undefined;
}> = {}) {
	const entries = overrides.entries ?? [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
	];
	return {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp/sessions",
		getSessionId: () => overrides.sessionId ?? "session-1",
		getSessionFile: () => overrides.sessionFile ?? "/tmp/sessions/session-1.jsonl",
		getLeafId: () => (overrides.leafId === undefined ? "leaf-1" : overrides.leafId),
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getHeader: () => null,
		getEntries: () => entries,
		getTree: () => [],
		getSessionName: () => undefined,
	} as unknown as ReadonlySessionManager;
}

function makeModelRegistry(authOk = true) {
	return {
		find: vi.fn(),
		getApiKeyAndHeaders: vi.fn(async () =>
			authOk ? { ok: true as const, apiKey: "test-key", headers: {}, env: {} } : { ok: false as const, error: "no auth" },
		),
	};
}

describe("fork-context", () => {
	beforeEach(() => {
		clearForkSummaryCache();
		vi.mocked(generateSummaryWithUsage).mockReset();
	});

	afterEach(() => {
		clearForkSummaryCache();
	});

	it("returns undefined when session has no entries", async () => {
		const sessionManager = makeSessionManager({ entries: [] });
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(result).toBeUndefined();
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("returns undefined when no fallback model is provided", async () => {
		const sessionManager = makeSessionManager();
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
		});
		expect(result).toBeUndefined();
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("returns undefined when model auth resolution fails", async () => {
		const sessionManager = makeSessionManager();
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(false),
			fallbackModel: makeFallbackModel(),
		});
		expect(result).toBeUndefined();
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("generates a structured summary and includes parent session file", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({
			text: "## Goal\nTest the fork summary.",
			usage: makeUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
		});
		const sessionManager = makeSessionManager({ sessionFile: "/tmp/sessions/session-1.jsonl" });
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(result).toBeDefined();
		expect(result?.summary).toContain("## Goal");
		expect(result?.parentSessionFile).toBe("/tmp/sessions/session-1.jsonl");
		expect(result?.entryCount).toBe(2);
	});

	it("returns undefined when summary text is empty", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({ text: "   ", usage: makeUsage() });
		const sessionManager = makeSessionManager();
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined and does not throw when summarization call rejects", async () => {
		vi.mocked(generateSummaryWithUsage).mockRejectedValue(new Error("network error"));
		const sessionManager = makeSessionManager();
		const result = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(result).toBeUndefined();
	});

	it("caches the summary per session leaf id, avoiding duplicate LLM calls", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({ text: "## Goal\nCached.", usage: makeUsage() });
		const sessionManager = makeSessionManager();
		const first = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		const second = await generateForkSummary({
			sessionManager,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(first).toEqual(second);
		expect(generateSummaryWithUsage).toHaveBeenCalledTimes(1);
	});

	it("regenerates the summary when the session leaf changes", async () => {
		vi.mocked(generateSummaryWithUsage).mockResolvedValue({ text: "## Goal\nFresh.", usage: makeUsage() });
		const sessionManagerA = makeSessionManager({ leafId: "leaf-1" });
		const sessionManagerB = makeSessionManager({ leafId: "leaf-2" });
		await generateForkSummary({
			sessionManager: sessionManagerA,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		await generateForkSummary({
			sessionManager: sessionManagerB,
			modelRegistry: makeModelRegistry(),
			fallbackModel: makeFallbackModel(),
		});
		expect(generateSummaryWithUsage).toHaveBeenCalledTimes(2);
	});
});

describe("formatForkContextBlock", () => {
	it("wraps the summary with fork context boundary instructions", () => {
		const block = formatForkContextBlock({
			summary: "## Goal\nDo the thing.",
			entryCount: 5,
		});
		expect(block).toContain("delegated subagent running from a fork");
		expect(block).toContain("## Goal\nDo the thing.");
		expect(block).not.toContain("If you need an exact quote");
	});

	it("includes the escape-hatch note when parentSessionFile is present", () => {
		const block = formatForkContextBlock({
			summary: "## Goal\nDo the thing.",
			entryCount: 5,
			parentSessionFile: "/tmp/sessions/abc.jsonl",
		});
		expect(block).toContain("If you need an exact quote");
		expect(block).toContain("/tmp/sessions/abc.jsonl");
	});
});
