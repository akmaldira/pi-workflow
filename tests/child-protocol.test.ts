/**
 * Tests for child-protocol.ts — Bounded child process output handling
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	createBoundedByteTail,
	createBoundedLineReader,
	formatProtocolOutputLimit,
	MAX_CHILD_PENDING_LINE_BYTES,
	MAX_CHILD_STDERR_BYTES,
	projectChildLifecycle,
} from "../extensions/child-protocol.ts";

describe("child-protocol", () => {
	describe("createBoundedLineReader", () => {
		it("should emit lines on newline", () => {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				onLine: (line) => lines.push(line),
				onLimit: () => {},
			});

			reader.push(Buffer.from("line1\nline2\n"));
			expect(lines).toEqual(["line1", "line2"]);
		});

		it("should emit pending line on end", () => {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				onLine: (line) => lines.push(line),
				onLimit: () => {},
			});

			reader.push(Buffer.from("no newline"));
			reader.end();
			expect(lines).toEqual(["no newline"]);
		});

		it("should handle empty input", () => {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				onLine: (line) => lines.push(line),
				onLimit: () => {},
			});

			reader.push(Buffer.alloc(0));
			reader.end();
			expect(lines).toEqual([]);
		});

		it("should handle string input", () => {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				onLine: (line) => lines.push(line),
				onLimit: () => {},
			});

			reader.push("hello\nworld\n");
			expect(lines).toEqual(["hello", "world"]);
		});

		it("should trigger limit on long line", () => {
			const limits: any[] = [];
			const reader = createBoundedLineReader({
				maxPendingLineBytes: 100,
				onLine: () => {},
				onLimit: (limit) => limits.push(limit),
			});

			const longLine = "A".repeat(200);
			reader.push(Buffer.from(longLine));
			expect(limits.length).toBe(1);
			expect(limits[0].code).toBe("protocol_output_limit");
			expect(limits[0].stream).toBe("stdout");
			expect(limits[0].limitBytes).toBe(100);
			expect(limits[0].observedBytes).toBe(200);
		});

		it("should not emit after limit exceeded", () => {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				maxPendingLineBytes: 10,
				onLine: (line) => lines.push(line),
				onLimit: () => {},
			});

			reader.push(Buffer.from("A".repeat(20)));
			reader.push(Buffer.from("B".repeat(20)));
			expect(lines).toEqual([]);
		});

		it("should throw for invalid maxPendingLineBytes", () => {
			expect(() =>
				createBoundedLineReader({
					maxPendingLineBytes: 0,
					onLine: () => {},
					onLimit: () => {},
				}),
			).toThrow();
		});
	});

	describe("createBoundedByteTail", () => {
		it("should accumulate bytes", () => {
			const tail = createBoundedByteTail(100);
			tail.push(Buffer.from("hello"));
			tail.push(Buffer.from(" world"));
			expect(tail.text()).toBe("hello world");
			expect(tail.byteLength()).toBe(11);
		});

		it("should truncate to max bytes", () => {
			const tail = createBoundedByteTail(5);
			tail.push(Buffer.from("hello world"));
			expect(tail.byteLength()).toBe(5);
			expect(tail.text()).toBe("world");
		});

		it("should handle string input", () => {
			const tail = createBoundedByteTail(100);
			tail.push("hello");
			expect(tail.text()).toBe("hello");
		});

		it("should handle empty input", () => {
			const tail = createBoundedByteTail(100);
			tail.push(Buffer.alloc(0));
			expect(tail.text()).toBe("");
			expect(tail.byteLength()).toBe(0);
		});

		it("should throw for invalid maxBytes", () => {
			expect(() => createBoundedByteTail(0)).toThrow();
		});

		it("should use default maxBytes", () => {
			const tail = createBoundedByteTail();
			expect(tail).toBeDefined();
		});
	});

	describe("formatProtocolOutputLimit", () => {
		it("should format limit message", () => {
			const limit = {
				code: "protocol_output_limit" as const,
				stream: "stdout" as const,
				limitBytes: 100,
				observedBytes: 200,
				diagnosticPrefix: "prefix",
				diagnosticTail: "suffix",
			};
			const msg = formatProtocolOutputLimit(limit);
			expect(msg).toContain("protocol_output_limit");
			expect(msg).toContain("stdout");
			expect(msg).toContain("100");
			expect(msg).toContain("200");
		});
	});

	describe("projectChildLifecycle", () => {
		it("should return cancel-drain for agent_end with willRetry", () => {
			expect(projectChildLifecycle({ type: "agent_end", willRetry: true })).toBe("cancel-drain");
		});

		it("should return start-drain for agent_settled", () => {
			expect(projectChildLifecycle({ type: "agent_settled" })).toBe("start-drain");
		});

		it("should return start-drain for terminal assistant stop", () => {
			expect(projectChildLifecycle({}, true)).toBe("start-drain");
		});

		it("should return none for other events", () => {
			expect(projectChildLifecycle({ type: "other" })).toBe("none");
		});

		it("should return none for agent_end without willRetry", () => {
			expect(projectChildLifecycle({ type: "agent_end", willRetry: false })).toBe("none");
		});
	});

	describe("constants", () => {
		it("should have correct MAX_CHILD_PENDING_LINE_BYTES", () => {
			expect(MAX_CHILD_PENDING_LINE_BYTES).toBe(16 * 1024 * 1024);
		});

		it("should have correct MAX_CHILD_STDERR_BYTES", () => {
			expect(MAX_CHILD_STDERR_BYTES).toBe(128 * 1024);
		});
	});
});
