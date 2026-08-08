/**
 * Delivers a finished background run back into the conversation.
 *
 * Runs are background-only, so a graph's report is no longer a tool result —
 * the tool returned a run id and the turn ended long before the walk finished.
 * The report therefore has to be injected as its own message, and it has to
 * trigger a turn: a report the model never reads is the same as no report.
 *
 * `deliverAs: "followUp"` is the delivery mode that respects the user. If they
 * are mid-turn when the run finishes, the report waits until that turn is done
 * rather than interrupting it. `"steer"` would cut in; `"nextTurn"` would sit
 * silently until the user happened to type something.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.ts";

/** What a completed run supplies for delivery. */
export interface DeliverableRun {
	runId: string;
	name: string;
	text: string;
}

/**
 * Installed once per manager, not once per extension generation.
 *
 * The manager outlives `/reload` — it holds live runs — so registering the
 * listeners again on every reload would deliver each result N times. The guard
 * makes registration exactly-once while the holder keeps the *current*
 * generation's `pi` reachable, since the one captured at first install goes
 * stale on reload.
 */
interface DeliveryHolder {
	pi: ExtensionAPI;
}

interface ManagerWithDelivery {
	__deliveryInstalled?: boolean;
	__deliveryHolder?: DeliveryHolder;
	__pendingReports?: Map<string, DeliverableRun>;
}

function holderOf(manager: WorkflowManager): ManagerWithDelivery {
	return manager as unknown as ManagerWithDelivery;
}

/**
 * Records the report a run should deliver when it completes.
 *
 * The manager's `complete`/`error` events carry a runId but not the rendered
 * report, and the report is built by the run itself. Staging it here keeps the
 * event handlers free of run-execution knowledge.
 */
export function stageRunReport(manager: WorkflowManager, report: DeliverableRun): void {
	const m = holderOf(manager);
	m.__pendingReports ??= new Map();
	m.__pendingReports.set(report.runId, report);
}

function takeRunReport(manager: WorkflowManager, runId: string): DeliverableRun | undefined {
	const m = holderOf(manager);
	const report = m.__pendingReports?.get(runId);
	if (report) m.__pendingReports?.delete(runId);
	return report;
}

export function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager): void {
	const m = holderOf(manager);

	if (m.__deliveryInstalled) {
		// Refresh the generation-bound dependency, leave registration alone.
		if (m.__deliveryHolder) m.__deliveryHolder.pi = pi;
		return;
	}
	m.__deliveryInstalled = true;
	m.__deliveryHolder = { pi };

	const deliver = (content: string): void => {
		try {
			const sent = m.__deliveryHolder?.pi.sendMessage(
				{ customType: "workflow-result", content, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			// sendMessage may return a promise, which a synchronous try/catch
			// cannot catch. A stale ctx after /reload is the expected failure;
			// the report is still readable via /workflows either way.
			void Promise.resolve(sent).catch(() => {});
		} catch {
			// Same reasoning as above, for the synchronous throw path.
		}
	};

	manager.on("complete", ({ runId }: { runId: string }) => {
		const report = takeRunReport(manager, runId);
		if (report) deliver(report.text);
	});

	manager.on("error", ({ runId, error }: { runId: string; error?: string }) => {
		const report = takeRunReport(manager, runId);
		// A failed run still has a full report — path, escalations, resume id —
		// and that is exactly when it is most worth reading. Fall back to the
		// bare error only when the run failed before building one.
		deliver(report?.text ?? `Workflow run ${runId} failed: ${error ?? "unknown error"}`);
	});

	manager.on("stopped", ({ runId }: { runId: string }) => {
		const report = takeRunReport(manager, runId);
		deliver(
			report?.text ??
				`Workflow run ${runId} was stopped. Completed nodes are journaled; resume it with resumeRunId: "${runId}".`,
		);
	});
}
