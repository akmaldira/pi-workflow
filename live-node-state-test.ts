/**
 * LIVE end-to-end test for the node_state tool.
 *
 * Drives the real workflow tool with the REAL spawnAgent (runSingleAgent),
 * so graph nodes run as actual pi child processes with a real model. The
 * host stays alive (unlike `pi -p`, which exits after one turn and kills
 * the detached background run).
 *
 * Usage: node live-node-state-test.ts [--script path]
 *
 * The graph: an extractor node calls node_state twice, then a reader node
 * reads the accumulated data from s.extractor.data and reports it. The test
 * asserts the reader's output contains the values the extractor wrote.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGraphWorkflowTool, type GraphToolOptions } from "/opt/workspaces/pi-workflow/extensions/graph-tool.ts";
import { runSingleAgent } from "/opt/workspaces/pi-workflow/extensions/execution.ts";
import { trackDetached } from "/opt/workspaces/pi-workflow/tests/helpers/detached.ts";
import type { GraphRunReport } from "/opt/workspaces/pi-workflow/extensions/graph-run.ts";
import { RequestBroker } from "/opt/workspaces/pi-workflow/extensions/request-broker.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "node-state-live-"));

const SCRIPT = `export const meta = { name: "node_state_live", description: "live e2e test" };
const g = graph();
g.node("extractor", agent("scout", (s) => \`You MUST call the node_state tool twice:
1. node_state({ action: "set", key: "invoice_number", value: "INV-LIVE-001", meta: { source: "doc_test" } })
2. node_state({ action: "set", key: "vendor", value: "Acme Corp" })
Then reply with exactly: done\`));
g.node("reader", agent("scout", (s) => \`The previous node's accumulated node_state data is available as s.extractor.data (an object).
Report EXACTLY one line and nothing else:
RESULT: \${s.extractor.data?.invoice_number} / \${s.extractor.data?.vendor}\`));
g.edge("extractor", "reader");
g.edge("reader", END);
g.run({});
`;

async function main(): Promise<void> {
	console.log(`[live] cwd: ${cwd}`);

	// Real spawn: actual pi children with the real model.
	// A broker is required: executeGraphRun only starts the channel poller
	// (which answers node_state requests) when one is provided. index.ts
	// passes globalBroker in production; the harness creates its own.
	const broker = new RequestBroker();
	broker.start();
	const options: GraphToolOptions = {
		spawnAgent: runSingleAgent as never,
		broker,
	};

	const tracker = trackDetached();
	const tool = createGraphWorkflowTool({
		...options,
		onRunDetached: (info) => {
			console.log(`[live] run detached: ${info.runId}`);
			tracker.onRunDetached(info);
		},
	});

	console.log("[live] executing workflow tool with real spawnAgent...");
	const receipt = (await tool.execute(
		"live-call",
		{ script: SCRIPT, args: {} } as never,
		new AbortController().signal,
		() => {},
		{ cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined } as never,
	)) as { content?: Array<{ text?: string }> };

	console.log("[live] receipt:", (receipt.content ?? []).map((c) => c.text ?? "").join("\n"));

	console.log("[live] waiting for detached run to settle...");
	const report: GraphRunReport | undefined = await tracker.settled();
	if (!report) {
		console.error("[live] FAIL: no report (run crashed or never started)");
		process.exit(1);
	}

	console.log(`[live] report status: ${report.status}`);
	console.log(`[live] iterations: ${report.iterations}, nodeExecutions: ${report.nodeExecutions}`);

	const state = report.result.state as Record<string, { data?: Record<string, unknown>; text?: string }>;
	console.log("[live] state keys:", Object.keys(state).join(", "));

	const extractor = state.extractor;
	const reader = state.reader;

	console.log("[live] extractor.data:", JSON.stringify(extractor?.data ?? null));
	console.log("[live] reader.text:", reader?.text ?? "(no text)");

	const data = extractor?.data ?? {};
	let failures = 0;
	if (data.invoice_number !== "INV-LIVE-001") {
		console.error("[live] FAIL: extractor.data.invoice_number =", data.invoice_number);
		failures++;
	}
	if (data.vendor !== "Acme Corp") {
		console.error("[live] FAIL: extractor.data.vendor =", data.vendor);
		failures++;
	}
	const readerText = reader?.text ?? "";
	if (!readerText.includes("INV-LIVE-001") || !readerText.includes("Acme Corp")) {
		console.error("[live] FAIL: reader did not see the accumulated data. reader.text =", readerText);
		failures++;
	}

	if (failures > 0) {
		console.error(`[live] FAIL: ${failures} assertion(s) failed`);
		process.exit(1);
	}

	console.log("[live] PASS: node_state wrote durable per-node data, reader saw it downstream");
	console.log(`[live] run artifacts/journal in ${cwd}`);
}

main().catch((error) => {
	console.error("[live] ERROR:", error);
	process.exit(1);
});
