/**
 * Tests for the node_state tool.
 *
 * Covers the three execution contexts the design hinges on:
 *  - main agent (no channel at all) → refuses
 *  - plain subagent call (channel present, no node id) → refuses
 *  - graph agent() node (channel + node id) → works, routes via the channel
 *
 * The host-side reducer is exercised separately in node-state-reducer.test.ts;
 * these tests verify the tool's client-side behaviour and gating only,
 * mocking the host by replying through a real ChannelPoller.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeStateTool } from "../extensions/node-state-tool.ts";
import {
	PI_WORKFLOW_CHANNEL_DIR_ENV,
	PI_WORKFLOW_NODE_ID_ENV,
	PI_WORKFLOW_RUN_ID_ENV,
	ChannelPoller,
	ensureChannel,
} from "../extensions/channel.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTool(params: Record<string, unknown>) {
	const tool = createNodeStateTool();
	const result = await tool.execute(
		"call-1",
		params as never,
		undefined,
		undefined,
		{} as never,
	);
	return result as {
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	};
}

describe("node_state tool: gating", () => {
	it("refuses in the main agent context (no channel env)", async () => {
		// No channel env set at all — ChannelClient.fromEnv() returns null.
		const res = await runTool({ action: "set", key: "k", value: "v" });

		expect(res.details.refused).toBe(true);
		expect(res.details.reason).toBe("not a graph node");
		expect(res.content[0].text).toMatch(/only available inside a workflow graph run/);
	});
});

describe("node_state tool: child context, no node id (plain subagent call)", () => {
	let tmpDir: string;
	let chDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-state-no-node-"));
		chDir = path.join(tmpDir, "channels", "run-1");
		ensureChannel(chDir);
		process.env[PI_WORKFLOW_CHANNEL_DIR_ENV] = chDir;
		process.env[PI_WORKFLOW_RUN_ID_ENV] = "run-1";
		// PI_WORKFLOW_NODE_ID deliberately NOT set — this is a plain subagent call.
		delete process.env[PI_WORKFLOW_NODE_ID_ENV];
	});

	afterEach(() => {
		delete process.env[PI_WORKFLOW_CHANNEL_DIR_ENV];
		delete process.env[PI_WORKFLOW_RUN_ID_ENV];
		delete process.env[PI_WORKFLOW_NODE_ID_ENV];
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("refuses with a clear error when channel present but no node id", async () => {
		const res = await runTool({ action: "set", key: "k", value: "v" });

		expect(res.details.refused).toBe(true);
		expect(res.details.reason).toBe("not a graph node");
		expect(res.content[0].text).toMatch(/only available inside a workflow graph run/);
	});

	it("refuses for read actions too, not just writes", async () => {
		const res = await runTool({ action: "list" });
		expect(res.details.refused).toBe(true);
	});
});

describe("node_state tool: graph node (channel + node id)", () => {
	let tmpDir: string;
	let chDir: string;
	let poller: ChannelPoller;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-state-graph-"));
		chDir = path.join(tmpDir, "channels", "run-1");
		ensureChannel(chDir);
		process.env[PI_WORKFLOW_CHANNEL_DIR_ENV] = chDir;
		process.env[PI_WORKFLOW_RUN_ID_ENV] = "run-1";
		process.env[PI_WORKFLOW_NODE_ID_ENV] = "extract_a";
	});

	afterEach(() => {
		poller?.stop("test cleanup");
		delete process.env[PI_WORKFLOW_CHANNEL_DIR_ENV];
		delete process.env[PI_WORKFLOW_RUN_ID_ENV];
		delete process.env[PI_WORKFLOW_NODE_ID_ENV];
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("routes a set request through the channel with the node id", async () => {
		let receivedNodeId: string | undefined;
		let receivedAction: unknown;
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				receivedNodeId = req.nodeId;
				receivedAction = req.stateAction;
				poller.reply(req.id, { source: "state", stateOk: true, stateValue: req.stateAction?.value });
			},
		});

		const toolPromise = runTool({ action: "set", key: "invoice", value: "INV-4471" });
		await sleep(20);
		poller.poll();

		const res = await toolPromise;
		expect(receivedNodeId).toBe("extract_a");
		expect(receivedAction).toEqual({ action: "set", key: "invoice", value: "INV-4471" });
		expect(res.details.ok).toBe(true);
		expect(res.details.value).toBe("INV-4471");
		expect(res.content[0].text).toContain("set");
	});

	it("returns the reduced value for a get, not the action envelope", async () => {
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				poller.reply(req.id, {
					source: "state",
					stateOk: true,
					stateValue: "INV-4471", // host returns the reduced value
				});
			},
		});

		const toolPromise = runTool({ action: "get", key: "invoice" });
		await sleep(20);
		poller.poll();

		const res = await toolPromise;
		expect(res.details.ok).toBe(true);
		expect(res.details.value).toBe("INV-4471");
		// No 'action' field leaking into the value — it's the reduced value only.
		expect(res.details.value).not.toHaveProperty("action");
		expect(res.content[0].text).toContain("INV-4471");
	});

	it("returns all accumulated keys for list", async () => {
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				poller.reply(req.id, {
					source: "state",
					stateOk: true,
					stateValue: { invoice: "INV-1", vendor: "Acme" },
				});
			},
		});

		const toolPromise = runTool({ action: "list" });
		await sleep(20);
		poller.poll();

		const res = await toolPromise;
		expect(res.details.ok).toBe(true);
		expect(res.details.value).toEqual({ invoice: "INV-1", vendor: "Acme" });
		expect(res.content[0].text).toMatch(/2 keys accumulated/);
	});

	it("surfaces a reducer error from the host", async () => {
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				poller.reply(req.id, {
					source: "state",
					stateOk: false,
					stateError: "merge requires an object value.",
				});
			},
		});

		const toolPromise = runTool({ action: "merge", key: "summary", value: "not an object" });
		await sleep(20);
		poller.poll();

		const res = await toolPromise;
		expect(res.details.ok).toBe(false);
		expect(res.details.error).toBe("merge requires an object value.");
		expect(res.content[0].text).toMatch(/failed/);
	});

	it("passes meta through when provided", async () => {
		let receivedMeta: unknown;
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				receivedMeta = req.stateAction?.meta;
				poller.reply(req.id, { source: "state", stateOk: true });
			},
		});

		const toolPromise = runTool({
			action: "set",
			key: "invoice",
			value: "INV-1",
			meta: { source: "doc_17.pdf:p3" },
		});
		await sleep(20);
		poller.poll();

		await toolPromise;
		expect(receivedMeta).toEqual({ source: "doc_17.pdf:p3" });
	});

	it("omits key/value/meta from the request when not provided", async () => {
		let receivedAction: unknown;
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				receivedAction = req.stateAction;
				poller.reply(req.id, { source: "state", stateOk: true, stateValue: {} });
			},
		});

		const toolPromise = runTool({ action: "list" });
		await sleep(20);
		poller.poll();

		await toolPromise;
		expect(receivedAction).toEqual({ action: "list" });
	});
});
