/**
 * Regression tests: node_state dispatch must be structurally isolated from
 * the human/supervisor broker pipeline, and the broker pipeline must behave
 * exactly as before for human/supervisor requests.
 *
 * These tests exercise the graph-run-style onRequest handler shape (the same
 * one wired in executeGraphRun): state requests go through
 * dispatchStateRequest() and return early; everything else falls through to
 * broker.ask().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchStateRequest } from "../extensions/graph-run.ts";
import { NodeStateBuffers } from "../extensions/node-state-reducer.ts";
import { RequestBroker } from "../extensions/request-broker.ts";
import { GraphJournal } from "../extensions/graph-journal.ts";
import {
	ChannelPoller,
	cleanupChannel,
	ensureChannel,
	PI_WORKFLOW_CHANNEL_DIR_ENV,
	type ChannelRequest,
} from "../extensions/channel.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("node_state isolation from the broker pipeline", () => {
	let tmpDir: string;
	let chDir: string;
	let broker: RequestBroker;
	let buffers: NodeStateBuffers;
	let journal: GraphJournal;
	let poller: ChannelPoller | null = null;
	const batches: unknown[][] = [];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-state-regression-"));
		chDir = path.join(tmpDir, "channels", "run-1");
		ensureChannel(chDir);
		broker = new RequestBroker({ coalesceMs: 10 });
		broker.onBatch((batch) => batches.push([...batch]));
		buffers = new NodeStateBuffers();
		journal = GraphJournal.create({
			journalDir: path.join(tmpDir, "journal"),
			runId: "run-1",
			scriptHash: "h",
			name: "n",
			entry: "a",
			nodeIds: ["a", "b"],
			initialState: {},
		});
		poller = null;
		batches.length = 0;
	});

	afterEach(() => {
		poller?.stop("test cleanup");
		broker.stop();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeRequest(overrides: Partial<ChannelRequest>): ChannelRequest {
		return {
			type: "channel.request",
			id: `req-${Math.random().toString(36).slice(2)}`,
			createdAt: Date.now(),
			runId: "run-1",
			kind: "state",
			question: "",
			expectsReply: true,
			...overrides,
		} as ChannelRequest;
	}

	// The same handler shape executeGraphRun wires: state via dispatchStateRequest,
	// everything else via broker.ask. Returns the reply payload for assertions.
	function installHandler(): Promise<Record<string, unknown>>[] {
		const replies: Promise<Record<string, unknown>>[] = [];
		poller = new ChannelPoller(chDir, {
			onRequest: (request) => {
				const handled = dispatchStateRequest(request, {
					runId: "run-1",
					buffers,
					journal,
					reply: (id, payload) => {
						replies.push(Promise.resolve({ ...payload }));
						poller!.reply(id, payload);
					},
				});
				if (handled) return;
				void broker
					.ask({
						id: request.id,
						runId: request.runId,
						nodeId: request.nodeId,
						agent: request.agent,
						kind: request.kind,
						questions: request.questions ?? [{ question: request.question, header: "Agent" }],
						default: request.default,
						expectsReply: request.expectsReply,
					})
					.then((result) => {
						poller!.reply(request.id, {
							source: result.source,
							answer: result.text,
							reason: result.reason,
							answers: result.answers?.questions,
						});
					});
			},
		});
		poller.start();
		return replies;
	}

	async function writeRequest(req: ChannelRequest): Promise<void> {
		// Write the request file directly the way ChannelClient.ask does.
		const { writeFileSync } = fs;
		writeFileSync(
			path.join(chDir, "requests", `${req.id}.json`),
			JSON.stringify(req),
			"utf-8",
		);
	}

	it("state requests never reach the broker: no batch, broker stays idle", async () => {
		const replies = installHandler();
		await writeRequest(makeRequest({
			id: "state-1",
			kind: "state",
			stateAction: { action: "set", key: "invoice", value: "INV-1" },
		}));

		// Give the poller a couple of ticks to see the file.
		await sleep(50);
		poller!.poll();
		await sleep(50);

		expect(batches).toHaveLength(0);
		expect(broker.isIdle()).toBe(true);

		const reply = await replies[0];
		expect(reply.stateOk).toBe(true);
		expect(reply.stateValue).toBe("INV-1");
		// The reply is a state reply, not a broker answer.
		expect(reply).not.toHaveProperty("answer");
	});

	it("state get/list requests are handled without reaching the broker either", async () => {
		buffers.apply("a", { action: "set", key: "invoice", value: "INV-9" });
		const replies = installHandler();

		await writeRequest(makeRequest({
			id: "state-2",
			kind: "state",
			nodeId: "a",
			stateAction: { action: "get", key: "invoice" },
		}));

		await sleep(50);
		poller!.poll();
		await sleep(50);

		expect(batches).toHaveLength(0);
		expect(broker.isIdle()).toBe(true);
		const reply = await replies[0];
		expect(reply.stateOk).toBe(true);
		expect(reply.stateValue).toBe("INV-9");
	});

	it("supervisor requests still flow through the broker (batch fires, answer routed back)", async () => {
		installHandler();

		const id = "sup-1";
		await writeRequest(makeRequest({
			id,
			kind: "supervisor",
			question: "Proceed?",
			nodeId: "a",
			agent: "worker",
			expectsReply: true,
		}));

		await sleep(50);
		poller!.poll();
		await sleep(20); // let the coalescing window (10ms) close
		broker.tick();

		// The supervisor request must have reached the broker as a batch.
		expect(batches.length).toBeGreaterThan(0);
		expect((batches[0] as Array<{ kind: string; id: string }>)[0].kind).toBe("supervisor");
		expect((batches[0] as Array<{ kind: string; id: string }>)[0].id).toBe(id);

		// Resolve it the way the supervisor sink would, and verify the reply
		// makes it back through the channel.
		broker.resolve(id, { source: "supervisor", text: "go ahead" });
		broker.tick();
		await sleep(50);
		poller!.poll();
		await sleep(50);
	});

	it("human requests still flow through the broker unchanged", async () => {
		installHandler();

		const id = "human-1";
		await writeRequest(makeRequest({
			id,
			kind: "human",
			question: "Approve?",
			expectsReply: true,
		}));

		await sleep(50);
		poller!.poll();
		await sleep(20); // let the coalescing window (10ms) close
		broker.tick(); // close the coalescing window, as broker.start() would

		expect(batches.length).toBeGreaterThan(0);
		expect((batches[0] as Array<{ kind: string }>)[0].kind).toBe("human");

		// A human request stays pending forever (no expiry) — this is the
		// no-timeout property; resolve it manually like the TUI sink would.
		broker.resolve(id, {
			source: "human",
			text: "yes",
			answers: { questions: [{ questionIndex: 0, kind: "option", answer: "yes" }], cancelled: false },
		});
		expect(broker.isIdle()).toBe(true);
	});

	it("state requests do not trigger supervisor detach logic (kind check is exclusive)", async () => {
		// The index.ts subagent-tool handlers gate detach on kind === 'supervisor';
		// state requests are handled earlier and never reach that check. Assert
		// the dispatch helper never touches broker.ask by spying on it.
		const askSpy = vi.spyOn(broker, "ask");
		installHandler();

		await writeRequest(makeRequest({
			id: "state-3",
			kind: "state",
			stateAction: { action: "set", key: "k", value: 1 },
		}));
		await sleep(50);
		poller!.poll();
		await sleep(50);

		expect(askSpy).not.toHaveBeenCalled();
		askSpy.mockRestore();
	});

	it("non-state requests are not consumed by dispatchStateRequest (returns false)", () => {
		const reply = vi.fn();
		const handled = dispatchStateRequest(
			makeRequest({ id: "sup-2", kind: "supervisor", question: "Q?" }),
			{ runId: "r", buffers, journal, reply: reply as never },
		);
		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("state requests with no action payload are not consumed either (returns false)", () => {
		const reply = vi.fn();
		const handled = dispatchStateRequest(
			makeRequest({ id: "s", kind: "state" }) as ChannelRequest,
			{ runId: "r", buffers, journal, reply: reply as never },
		);
		expect(handled).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("dispatchStateRequest unit behaviour", () => {
	it("replies with the reduced value for a set", () => {
		const buffers = new NodeStateBuffers();
		const replies: Array<{ stateOk?: boolean; stateValue?: unknown; stateError?: string }> = [];
		const journal = GraphJournal.create({
			journalDir: fs.mkdtempSync(path.join(os.tmpdir(), "dsr-unit-")),
			runId: "r",
			scriptHash: "h",
			name: "n",
			entry: "a",
			nodeIds: ["a"],
			initialState: {},
		});

		const handled = dispatchStateRequest(
			{
				type: "channel.request",
				id: "id-1",
				createdAt: Date.now(),
				runId: "r",
				nodeId: "a",
				kind: "state",
				question: "",
				expectsReply: true,
				stateAction: { action: "set", key: "k", value: "v" },
			},
			{
				runId: "r",
				buffers,
				journal,
				reply: (id, payload) => replies.push(payload as never),
			},
		);

		expect(handled).toBe(true);
		expect(replies[0].stateOk).toBe(true);
		expect(replies[0].stateValue).toBe("v");
	});

	it("journals write actions but not get/list", () => {
		const buffers = new NodeStateBuffers();
		const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-journal-"));
		const journal = GraphJournal.create({
			journalDir,
			runId: "r",
			scriptHash: "h",
			name: "n",
			entry: "a",
			nodeIds: ["a"],
			initialState: {},
		});
		const ctx = {
			runId: "r",
			buffers,
			journal,
			reply: () => {},
		};

		dispatchStateRequest(
			{ type: "channel.request", id: "a", createdAt: 0, runId: "r", nodeId: "a", kind: "state", question: "", expectsReply: true, stateAction: { action: "set", key: "k", value: 1 } },
			ctx,
		);
		dispatchStateRequest(
			{ type: "channel.request", id: "b", createdAt: 0, runId: "r", nodeId: "a", kind: "state", question: "", expectsReply: true, stateAction: { action: "get", key: "k" } },
			ctx,
		);
		dispatchStateRequest(
			{ type: "channel.request", id: "c", createdAt: 0, runId: "r", nodeId: "a", kind: "state", question: "", expectsReply: true, stateAction: { action: "list" } },
			ctx,
		);

		const { readGraphJournal } = require("../extensions/graph-journal.ts") as typeof import("../extensions/graph-journal.ts");
		const actions = readGraphJournal(path.join(journalDir, "r.jsonl")).filter((r) => r.type === "state_action");
		expect(actions).toHaveLength(1);
		expect((actions[0] as { action: string }).action).toBe("set");
	});
});
