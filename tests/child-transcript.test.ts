/**
 * Tests for child-transcript.ts — regression coverage for the
 * extractTextFromContent(message.content) double-unwrap bug that produced
 * "[]" literal text in transcript records instead of real message content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createChildTranscriptWriter } from "../extensions/child-transcript.ts";

describe("child-transcript", () => {
	let tempDir: string;
	let transcriptPath: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-test-transcript-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		transcriptPath = path.join(tempDir, "transcript.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function readRecords(): any[] {
		const content = fs.readFileSync(transcriptPath, "utf-8");
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	}

	it("writes real assistant text content, not an empty array literal", () => {
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		writer.writeChildEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I have completed the task successfully." }],
			} as any,
		});

		const records = readRecords();
		const messageRecord = records.find((r) => r.recordType === "message" && r.role === "assistant");
		expect(messageRecord).toBeDefined();
		expect(messageRecord.text).toBe("I have completed the task successfully.");
		expect(messageRecord.text).not.toBe("[]");
	});

	it("writes real toolResult content, not an empty array literal", () => {
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		writer.writeChildEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "export function foo() {}\n" }],
			} as any,
		});

		const records = readRecords();
		const messageRecord = records.find((r) => r.recordType === "message" && r.role === "toolResult");
		expect(messageRecord).toBeDefined();
		expect(messageRecord.text).toBe("export function foo() {}\n");
		expect(messageRecord.text).not.toBe("[]");
	});

	it("joins multiple text blocks with newlines", () => {
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		writer.writeChildEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "First paragraph." },
					{ type: "text", text: "Second paragraph." },
				],
			} as any,
		});

		const records = readRecords();
		const messageRecord = records.find((r) => r.recordType === "message" && r.role === "assistant");
		expect(messageRecord.text).toBe("First paragraph.\nSecond paragraph.");
	});

	it("omits text field when content has no text blocks (e.g. tool-call-only message)", () => {
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		writer.writeChildEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			} as any,
		});

		const records = readRecords();
		const messageRecord = records.find((r) => r.recordType === "message" && r.role === "assistant");
		expect(messageRecord).toBeDefined();
		expect(messageRecord.text).toBeUndefined();
	});

	it("records tool_start events with toolName and args preview", () => {
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		writer.writeChildEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "foo.ts" },
		});

		const records = readRecords();
		const toolStart = records.find((r) => r.recordType === "tool_start");
		expect(toolStart).toBeDefined();
		expect(toolStart.toolName).toBe("read");
		expect(toolStart.argsPreview).toContain("foo.ts");
	});

	it("exposes a close() method that does not throw", () => {
		// Regression test: execution.ts unconditionally calls
		// shared.transcriptWriter?.close() after every agent run. The writer
		// previously had no close() method at all, which threw
		// "shared.transcriptWriter?.close is not a function" and clobbered the
		// real agent result with that error message (surfaced in the
		// /workflows pager "Result:" section).
		const writer = createChildTranscriptWriter({ transcriptPath, source: "workflow", runId: "r1", agent: "worker" });
		expect(typeof writer.close).toBe("function");
		expect(() => writer.close()).not.toThrow();
	});
});
