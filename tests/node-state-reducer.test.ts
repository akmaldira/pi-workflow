import { describe, it, expect } from "vitest";
import { reduceNodeStateAction, readNodeStateValue, type NodeStateData } from "../extensions/node-state-reducer.ts";

describe("reduceNodeStateAction", () => {
	describe("set", () => {
		it("sets a new key", () => {
			const result = reduceNodeStateAction({}, { action: "set", key: "invoice_number", value: "INV-4471" });
			expect(result.ok).toBe(true);
			expect(result.data).toEqual({ invoice_number: "INV-4471" });
		});

		it("overwrites an existing key (last-write-wins, documented behavior)", () => {
			const before: NodeStateData = { invoice_number: "INV-4471" };
			const result = reduceNodeStateAction(before, { action: "set", key: "invoice_number", value: "INV-9902" });
			expect(result.data).toEqual({ invoice_number: "INV-9902" });
		});

		it("does not mutate the input object", () => {
			const before: NodeStateData = { a: 1 };
			reduceNodeStateAction(before, { action: "set", key: "b", value: 2 });
			expect(before).toEqual({ a: 1 });
		});

		it("preserves other keys", () => {
			const before: NodeStateData = { a: 1 };
			const result = reduceNodeStateAction(before, { action: "set", key: "b", value: 2 });
			expect(result.data).toEqual({ a: 1, b: 2 });
		});

		it("errors when key is missing", () => {
			const result = reduceNodeStateAction({}, { action: "set", value: "x" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/requires a key/);
			expect(result.data).toEqual({});
		});

		it("accepts null/undefined values", () => {
			const result = reduceNodeStateAction({}, { action: "set", key: "tax_id", value: null });
			expect(result.ok).toBe(true);
			expect(result.data).toEqual({ tax_id: null });
		});
	});

	describe("merge", () => {
		it("shallow-merges into a non-existent key", () => {
			const result = reduceNodeStateAction({}, { action: "merge", key: "summary", value: { risk: "low" } });
			expect(result.data).toEqual({ summary: { risk: "low" } });
		});

		it("shallow-merges into an existing object key", () => {
			const before: NodeStateData = { summary: { risk: "low" } };
			const result = reduceNodeStateAction(before, { action: "merge", key: "summary", value: { owner: "team-a" } });
			expect(result.data).toEqual({ summary: { risk: "low", owner: "team-a" } });
		});

		it("overwrites conflicting inner keys", () => {
			const before: NodeStateData = { summary: { risk: "low" } };
			const result = reduceNodeStateAction(before, { action: "merge", key: "summary", value: { risk: "high" } });
			expect(result.data).toEqual({ summary: { risk: "high" } });
		});

		it("treats a non-object existing value as empty base", () => {
			const before: NodeStateData = { summary: "not an object" };
			const result = reduceNodeStateAction(before, { action: "merge", key: "summary", value: { risk: "low" } });
			expect(result.data).toEqual({ summary: { risk: "low" } });
		});

		it("errors when value is not an object", () => {
			const result = reduceNodeStateAction({}, { action: "merge", key: "summary", value: "not an object" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/requires an object/);
		});

		it("errors when value is an array", () => {
			const result = reduceNodeStateAction({}, { action: "merge", key: "summary", value: [1, 2] });
			expect(result.ok).toBe(false);
		});

		it("errors when key is missing", () => {
			const result = reduceNodeStateAction({}, { action: "merge", value: { a: 1 } });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/requires a key/);
		});
	});

	describe("append", () => {
		it("appends onto a non-existent key", () => {
			const result = reduceNodeStateAction({}, { action: "append", key: "risks", value: "unclosed transaction" });
			expect(result.data).toEqual({ risks: ["unclosed transaction"] });
		});

		it("appends onto an existing array", () => {
			const before: NodeStateData = { risks: ["a"] };
			const result = reduceNodeStateAction(before, { action: "append", key: "risks", value: "b" });
			expect(result.data).toEqual({ risks: ["a", "b"] });
		});

		it("does not mutate the original array", () => {
			const originalArray = ["a"];
			const before: NodeStateData = { risks: originalArray };
			reduceNodeStateAction(before, { action: "append", key: "risks", value: "b" });
			expect(originalArray).toEqual(["a"]);
		});

		it("treats a non-array existing value as empty base", () => {
			const before: NodeStateData = { risks: "not an array" };
			const result = reduceNodeStateAction(before, { action: "append", key: "risks", value: "a" });
			expect(result.data).toEqual({ risks: ["a"] });
		});

		it("errors when key is missing", () => {
			const result = reduceNodeStateAction({}, { action: "append", value: "x" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/requires a key/);
		});
	});

	describe("get", () => {
		it("returns the data unchanged (read-only)", () => {
			const before: NodeStateData = { a: 1 };
			const result = reduceNodeStateAction(before, { action: "get", key: "a" });
			expect(result.data).toBe(before);
			expect(result.ok).toBe(true);
		});

		it("errors when key is missing", () => {
			const result = reduceNodeStateAction({ a: 1 }, { action: "get" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/requires a key/);
		});
	});

	describe("list", () => {
		it("returns the data unchanged (read-only)", () => {
			const before: NodeStateData = { a: 1, b: 2 };
			const result = reduceNodeStateAction(before, { action: "list" });
			expect(result.data).toBe(before);
			expect(result.ok).toBe(true);
		});

		it("does not require a key", () => {
			const result = reduceNodeStateAction({}, { action: "list" });
			expect(result.ok).toBe(true);
		});
	});

	describe("unknown action", () => {
		it("errors and returns data unchanged", () => {
			const before: NodeStateData = { a: 1 };
			// @ts-expect-error deliberately testing an invalid verb
			const result = reduceNodeStateAction(before, { action: "delete", key: "a" });
			expect(result.ok).toBe(false);
			expect(result.data).toBe(before);
		});
	});

	describe("sequence / convergence", () => {
		it("converges to the same final state regardless of call order for different keys", () => {
			const actionsA = [
				{ action: "set" as const, key: "x", value: 1 },
				{ action: "set" as const, key: "y", value: 2 },
			];
			const actionsB = [
				{ action: "set" as const, key: "y", value: 2 },
				{ action: "set" as const, key: "x", value: 1 },
			];
			const resultA = actionsA.reduce((data, action) => reduceNodeStateAction(data, action).data, {} as NodeStateData);
			const resultB = actionsB.reduce((data, action) => reduceNodeStateAction(data, action).data, {} as NodeStateData);
			expect(resultA).toEqual(resultB);
		});

		it("set is idempotent for the same key/value pair", () => {
			const once = reduceNodeStateAction({}, { action: "set", key: "a", value: 1 }).data;
			const twice = reduceNodeStateAction(once, { action: "set", key: "a", value: 1 }).data;
			expect(once).toEqual(twice);
		});
	});
});

describe("readNodeStateValue", () => {
	it("reads an existing key", () => {
		expect(readNodeStateValue({ a: 1 }, "a")).toBe(1);
	});

	it("returns undefined for a missing key", () => {
		expect(readNodeStateValue({ a: 1 }, "b")).toBeUndefined();
	});
});
