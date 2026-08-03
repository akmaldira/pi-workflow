import { describe, it, expect } from "vitest";
import { classifySingleResultFailure } from "../extensions/failure-classifier.ts";
import type { SingleResult } from "../extensions/types.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		task: "do something",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		...overrides,
	};
}

describe("classifySingleResultFailure", () => {
	it("classifies a clean success as none", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 0 }));
		expect(result.class).toBe("none");
		expect(result.code).toBe("ok");
	});

	it("classifies aborted runs as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 130, stopReason: "aborted" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("aborted");
	});

	it("classifies interrupted runs as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 130, interrupted: true }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("aborted");
	});

	it("classifies a SIGKILL exit signal as technical (process-killed)", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1 }), "SIGKILL");
		expect(result.class).toBe("technical");
		expect(result.code).toBe("process-killed");
		expect(result.reason).toContain("SIGKILL");
	});

	it("classifies a SIGSEGV exit signal as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1 }), "SIGSEGV");
		expect(result.class).toBe("technical");
		expect(result.code).toBe("process-killed");
	});

	it("does not classify a plain SIGTERM (normal cancellation) as process-killed", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "some tool failed" }), "SIGTERM");
		expect(result.code).not.toBe("process-killed");
	});

	it("classifies protocol output limit errors as technical", () => {
		const result = classifySingleResultFailure(
			makeResult({
				exitCode: 1,
				protocolError: {
					code: "protocol_output_limit",
					stream: "stdout",
					limitBytes: 1000,
					observedBytes: 2000,
					diagnosticPrefix: "",
					diagnosticTail: "",
				},
			}),
		);
		expect(result.class).toBe("technical");
		expect(result.code).toBe("protocol-limit");
	});

	it("classifies 'no model candidates available' as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "No model candidates available" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("no-model-available");
	});

	it("classifies rate limit errors as technical (provider-error)", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "Error: rate limit exceeded, please retry" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies quota errors as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "insufficient_quota: you have exceeded your quota" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies auth/API key errors as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "Invalid API key provided" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies network errors as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "fetch failed: ECONNRESET" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies out-of-memory error text as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "FATAL ERROR: JavaScript heap out of memory" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies internal server errors (500) as technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "500 Internal Server Error from provider" }));
		expect(result.class).toBe("technical");
		expect(result.code).toBe("provider-error");
	});

	it("classifies a tool execution failure as agent-level, not technical", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1, error: "bash failed (exit 1): command not found" }));
		expect(result.class).toBe("agent");
		expect(result.code).toBe("agent-error");
	});

	it("classifies an acceptance rejection as agent-level", () => {
		const result = classifySingleResultFailure(
			makeResult({ exitCode: 1, error: "Acceptance was rejected." }),
		);
		expect(result.class).toBe("agent");
		expect(result.code).toBe("agent-error");
	});

	it("classifies a generic non-zero exit with no error text as agent-level (fail-safe default)", () => {
		const result = classifySingleResultFailure(makeResult({ exitCode: 1 }));
		expect(result.class).toBe("agent");
		expect(result.code).toBe("agent-error");
	});

	it("does not classify 'the tests failed' agent output as technical", () => {
		const result = classifySingleResultFailure(
			makeResult({ exitCode: 1, error: "3 of 10 tests failed: expected 200 got 404" }),
		);
		expect(result.class).toBe("agent");
	});
});
