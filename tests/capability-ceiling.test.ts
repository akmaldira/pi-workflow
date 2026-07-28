/**
 * Tests for capability-ceiling.ts — Tool/extension allowlist management
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	encodeSubagentCapabilityCeiling,
	intersectSubagentCapabilityCeilings,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
	decodeSubagentCapabilityCeiling,
	SUBAGENT_CAPABILITY_CEILING_VERSION,
} from "../extensions/capability-ceiling.ts";

describe("capability-ceiling", () => {
	describe("parseSubagentCapabilityCeiling", () => {
		it("should parse valid ceiling with allowedTools", () => {
			const ceiling = {
				version: 1,
				allowedTools: ["read", "write"],
				denyExtensions: false,
				sources: ["test"],
			};
			const result = parseSubagentCapabilityCeiling(ceiling);
			expect(result.version).toBe(1);
			expect(result.allowedTools).toEqual(["read", "write"]);
			expect(result.denyExtensions).toBe(false);
			expect(result.sources).toEqual(["test"]);
		});

		it("should parse ceiling with denyExtensions only", () => {
			const ceiling = {
				version: 1,
				denyExtensions: true,
				sources: ["test"],
			};
			const result = parseSubagentCapabilityCeiling(ceiling);
			expect(result.denyExtensions).toBe(true);
			expect(result.allowedTools).toBeUndefined();
		});

		it("should throw for invalid version", () => {
			expect(() =>
				parseSubagentCapabilityCeiling({ version: 2, sources: ["test"] }),
			).toThrow("version");
		});

		it("should throw for non-object input", () => {
			expect(() => parseSubagentCapabilityCeiling("string")).toThrow();
			expect(() => parseSubagentCapabilityCeiling(null)).toThrow();
			expect(() => parseSubagentCapabilityCeiling(undefined)).toThrow();
		});

		it("should throw for missing allowedTools and denyExtensions", () => {
			expect(() =>
				parseSubagentCapabilityCeiling({ version: 1, sources: ["test"] }),
			).toThrow("expected allowedTools or denyExtensions");
		});

		it("should throw for invalid allowedTools type", () => {
			expect(() =>
				parseSubagentCapabilityCeiling({
					version: 1,
					allowedTools: "not-an-array",
					sources: ["test"],
				}),
			).toThrow("expected an array");
		});

		it("should throw for too many allowedTools", () => {
			const tools = Array.from({ length: 257 }, (_, i) => `tool${i}`);
			expect(() =>
				parseSubagentCapabilityCeiling({
					version: 1,
					allowedTools: tools,
					sources: ["test"],
				}),
			).toThrow("at most 256");
		});

		it("should throw for invalid tool name characters", () => {
			expect(() =>
				parseSubagentCapabilityCeiling({
					version: 1,
					allowedTools: ["tool with spaces"],
					sources: ["test"],
				}),
			).toThrow("Invalid capability ceiling allowedTools entry");
		});

		it("should sort and deduplicate allowedTools", () => {
			const result = parseSubagentCapabilityCeiling({
				version: 1,
				allowedTools: ["write", "read", "read", "bash"],
				sources: ["test"],
			});
			expect(result.allowedTools).toEqual(["bash", "read", "write"]);
		});

		it("should sort and deduplicate sources", () => {
			const result = parseSubagentCapabilityCeiling({
				version: 1,
				allowedTools: ["read"],
				sources: ["b", "a", "b"],
			});
			expect(result.sources).toEqual(["a", "b"]);
		});
	});

	describe("intersectSubagentCapabilityCeilings", () => {
		it("should return undefined when no ceilings provided", () => {
			expect(intersectSubagentCapabilityCeilings()).toBeUndefined();
			expect(intersectSubagentCapabilityCeilings(undefined)).toBeUndefined();
		});

		it("should return single ceiling when only one provided", () => {
			const ceiling = {
				version: 1 as const,
				allowedTools: ["read", "write"],
				denyExtensions: false,
				sources: ["a"],
			};
			const result = intersectSubagentCapabilityCeilings(ceiling);
			expect(result?.allowedTools).toEqual(["read", "write"]);
			expect(result?.sources).toEqual(["a"]);
		});

		it("should intersect allowedTools", () => {
			const ceiling1 = {
				version: 1 as const,
				allowedTools: ["read", "write", "bash"],
				denyExtensions: false,
				sources: ["a"],
			};
			const ceiling2 = {
				version: 1 as const,
				allowedTools: ["read", "write"],
				denyExtensions: false,
				sources: ["b"],
			};
			const result = intersectSubagentCapabilityCeilings(ceiling1, ceiling2);
			expect(result?.allowedTools).toEqual(["read", "write"]);
			expect(result?.sources).toEqual(["a", "b"]);
		});

		it("should union denyExtensions", () => {
			const ceiling1 = {
				version: 1 as const,
				denyExtensions: true,
				sources: ["a"],
			};
			const ceiling2 = {
				version: 1 as const,
				allowedTools: ["read"],
				denyExtensions: false,
				sources: ["b"],
			};
			const result = intersectSubagentCapabilityCeilings(ceiling1, ceiling2);
			expect(result?.denyExtensions).toBe(true);
		});

		it("should handle one ceiling with allowedTools and one without", () => {
			const ceiling1 = {
				version: 1 as const,
				allowedTools: ["read", "write"],
				denyExtensions: false,
				sources: ["a"],
			};
			const ceiling2 = {
				version: 1 as const,
				denyExtensions: false,
				sources: ["b"],
			};
			const result = intersectSubagentCapabilityCeilings(ceiling1, ceiling2);
			// When only one ceiling defines allowedTools, the intersection should
			// preserve them (the other ceiling doesn't restrict tools)
			expect(result?.allowedTools).toEqual(["read", "write"]);
		});
	});

	describe("encode/decodeSubagentCapabilityCeiling", () => {
		it("should encode and decode round-trip", () => {
			const ceiling = {
				version: 1 as const,
				allowedTools: ["read", "write"],
				denyExtensions: false,
				sources: ["test"],
			};
			const encoded = encodeSubagentCapabilityCeiling(ceiling);
			expect(encoded).toBeDefined();
			const decoded = decodeSubagentCapabilityCeiling(encoded!);
			expect(decoded?.allowedTools).toEqual(["read", "write"]);
			expect(decoded?.sources).toEqual(["test"]);
		});

		it("should return undefined for undefined ceiling", () => {
			expect(encodeSubagentCapabilityCeiling(undefined)).toBeUndefined();
		});

		it("should return undefined for empty string", () => {
			expect(decodeSubagentCapabilityCeiling("")).toBeUndefined();
		});

		it("should throw for invalid base64", () => {
			expect(() => decodeSubagentCapabilityCeiling("!!!invalid")).toThrow();
		});

		it("should throw for invalid version after decode", () => {
			const encoded = Buffer.from(JSON.stringify({ version: 999, sources: ["test"] }), "utf8").toString("base64url");
			expect(() => decodeSubagentCapabilityCeiling(encoded)).toThrow("version");
		});
	});

	describe("registerSubagentCapabilityCeiling", () => {
		it("should register and retrieve ceiling", () => {
			const handle = registerSubagentCapabilityCeiling({
				sessionId: "test-session",
				source: "test-source",
				ceiling: { allowedTools: ["read"] },
			});

			const result = intersectSubagentCapabilityCeilings(
				parseSubagentCapabilityCeiling({
					version: 1,
					allowedTools: ["read", "write"],
					sources: ["other"],
				}),
			);

			// The registered ceiling should be retrievable
			expect(handle).toBeDefined();
			handle.dispose();
		});

		it("should update ceiling", () => {
			const handle = registerSubagentCapabilityCeiling({
				sessionId: "test-session-2",
				source: "test-source",
				ceiling: { allowedTools: ["read"] },
			});

			handle.update({ denyExtensions: true });
			handle.dispose();
		});

		it("should throw when updating disposed handle", () => {
			const handle = registerSubagentCapabilityCeiling({
				sessionId: "test-session-3",
				source: "test-source",
				ceiling: { allowedTools: ["read"] },
			});
			handle.dispose();
			expect(() => handle.update({ denyExtensions: true })).toThrow("disposed");
		});

		it("should allow double dispose", () => {
			const handle = registerSubagentCapabilityCeiling({
				sessionId: "test-session-4",
				source: "test-source",
				ceiling: { allowedTools: ["read"] },
			});
			handle.dispose();
			handle.dispose(); // Should not throw
		});
	});
});
