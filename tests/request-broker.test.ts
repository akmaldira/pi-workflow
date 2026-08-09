/**
 * Tests for the request broker (extensions/request-broker.ts).
 *
 * The broker is driven by `tick()` rather than real timers, so tests advance
 * time manually. The properties tested are the three deliberate asymmetries:
 * human never expires, supervisor does, coalescing batches near-simultaneous
 * but not distant requests.
 */

import { describe, it, expect } from "vitest";
import { RequestBroker, type BrokerQuestion, type BrokerResult } from "../extensions/request-broker.ts";

function question(text = "Proceed?", header = "Q"): BrokerQuestion {
	return { question: text, header, options: [{ label: "yes" }, { label: "no" }] };
}

function tickMs(broker: RequestBroker, ms: number): void {
	// The broker reads Date.now(); we fake it by advancing and calling tick.
	const realNow = Date.now;
	const target = Date.now() + ms;
	(Date as unknown as { now: () => number }).now = () => target;
	broker.tick();
	(Date as unknown as { now: () => number }).now = realNow;
}

describe("RequestBroker", () => {
	it("resolves a request when the sink calls resolve()", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		const promise = broker.ask({
			runId: "r1",
			kind: "human",
			questions: [question()],
			expectsReply: true,
		});

		tickMs(broker, 100);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);

		broker.resolve(batches[0][0].id, { source: "human", text: "yes" });

		const result = await promise;
		expect(result.source).toBe("human");
		expect(result.text).toBe("yes");
	});

	it("coalesces requests arriving within the window into one batch", async () => {
		const broker = new RequestBroker({ coalesceMs: 300 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		broker.ask({ runId: "r1", kind: "human", questions: [question("A")], expectsReply: true });
		// Within the window:
		broker.ask({ runId: "r1", kind: "human", questions: [question("B")], expectsReply: true });

		tickMs(broker, 300);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
	});

	it("does not coalesce a request arriving after the window closed", () => {
		const broker = new RequestBroker({ coalesceMs: 100 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		broker.ask({ runId: "r1", kind: "human", questions: [question("A")], expectsReply: true });
		tickMs(broker, 100);

		broker.ask({ runId: "r1", kind: "human", questions: [question("B")], expectsReply: true });
		tickMs(broker, 100);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(1);
		expect(batches[1]).toHaveLength(1);
	});

	it("a cancelled human request with a default resolves to the default", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		const promise = broker.ask({
			runId: "r1",
			kind: "human",
			questions: [question()],
			default: "no",
			expectsReply: true,
		});

		tickMs(broker, 10);
		broker.cancel(batches[0][0].id);

		const result = await promise;
		expect(result.source).toBe("default");
		expect(result.text).toBe("no");
	});

	it("a cancelled human request with no default resolves cancelled", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		const promise = broker.ask({
			runId: "r1",
			kind: "human",
			questions: [question()],
			expectsReply: true,
		});

		tickMs(broker, 10);
		broker.cancel(batches[0][0].id);

		const result = await promise;
		expect(result.source).toBe("cancelled");
	});

	it("a cancelled supervisor request resolves cancelled even with a default", async () => {
		const broker = new RequestBroker({ coalesceMs: 0, supervisorTimeoutMs: 5000 });
		const batches: PendingRequest[][] = [];
		broker.onBatch((batch) => batches.push([...batch]));

		const promise = broker.ask({
			runId: "r1",
			kind: "supervisor",
			questions: [],
			default: "retry",
			expectsReply: true,
			agent: "worker",
		});

		tickMs(broker, 10);
		broker.cancel(batches[0][0].id);

		const result = await promise;
		expect(result.source).toBe("cancelled");
	});

	it("supervisor requests expire after the timeout with a proceed-on-best-judgement message", async () => {
		const broker = new RequestBroker({ coalesceMs: 0, supervisorTimeoutMs: 1000 });
		broker.onBatch(() => {});

		const promise = broker.ask({
			runId: "r1",
			kind: "supervisor",
			questions: [],
			expectsReply: true,
			agent: "worker",
		});

		// Advance past the deadline.
		tickMs(broker, 1100);

		const result = await promise;
		expect(result.source).toBe("timeout");
		expect(result.reason).toMatch(/best judgement|BLOCKED_ON/);
	});

	it("human requests never expire, even after the supervisor timeout", () => {
		const broker = new RequestBroker({ coalesceMs: 0, supervisorTimeoutMs: 500 });
		broker.onBatch(() => {});

		broker.ask({
			runId: "r1",
			kind: "human",
			questions: [question()],
			expectsReply: true,
		});

		tickMs(broker, 10);
		tickMs(broker, 600);
		tickMs(broker, 10000);

		// Still pending — human requests have no expiry.
		expect(broker.listPending()).toHaveLength(1);
	});

	it("cancelRun cancels every pending request for that run", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		broker.onBatch(() => {});

		const p1 = broker.ask({
			runId: "r1",
			kind: "human",
			questions: [question()],
			expectsReply: true,
		});
		const p2 = broker.ask({
			runId: "r2",
			kind: "human",
			questions: [question()],
			expectsReply: true,
		});

		broker.cancelRun("r1", "aborted");

		const r1 = await p1;
		expect(r1.source).toBe("cancelled");

		// r2 is untouched.
		expect(broker.listPendingForRun("r2")).toHaveLength(1);
		// Clean up.
		broker.cancelRun("r2");
		await p2;
	});

	it("isIdle when nothing is pending and no batch is open", () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		expect(broker.isIdle()).toBe(true);

		broker.ask({ runId: "r1", kind: "human", questions: [question()], expectsReply: true });
		expect(broker.isIdle()).toBe(false);
	});

	it("listPendingForRun returns only that run's requests", () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		broker.ask({ runId: "r1", kind: "human", questions: [question()], expectsReply: true });
		broker.ask({ runId: "r2", kind: "supervisor", questions: [], expectsReply: true, agent: "w" });

		expect(broker.listPendingForRun("r1")).toHaveLength(1);
		expect(broker.listPendingForRun("r1")[0].kind).toBe("human");
		expect(broker.listPendingForRun("r2")).toHaveLength(1);
		expect(broker.listPendingForRun("r2")[0].kind).toBe("supervisor");
	});

	it("markInlineDelivered sets inlineDelivered on the pending request", () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		broker.ask({ runId: "r1", kind: "supervisor", questions: [], expectsReply: true, agent: "w" });

		const [req] = broker.listPendingForRun("r1");
		expect(req.inlineDelivered).toBeUndefined();

		broker.markInlineDelivered(req.id);
		const [updated] = broker.listPendingForRun("r1");
		expect(updated.inlineDelivered).toBe(true);
	});

	it("markInlineDelivered on unknown id is a no-op", () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		expect(() => broker.markInlineDelivered("nonexistent")).not.toThrow();
	});
});

type PendingRequest = Parameters<RequestBroker["ask"]>[0] extends infer T
	? T extends Omit<infer R, "id" | "createdAt" | "expiresAt">
		? R
		: never
	: never;
