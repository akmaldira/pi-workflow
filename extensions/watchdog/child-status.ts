/**
 * Watchdog child status — child watchdog configuration and status tracking.
 * Matches pi-subagents/src/watchdog/child-status.ts for env-var compatibility.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_WATCHDOG_CONFIG_ENV = "PI_SUBAGENT_WATCHDOG_CHILD_CONFIG";
export const CHILD_WATCHDOG_STATUS_EVENT = "subagent.watchdog.status";

export const CHILD_WATCHDOG_PHASES = ["idle", "reviewing", "autofollow", "settling", "stale", "failed"] as const;
export type ChildWatchdogPhase = typeof CHILD_WATCHDOG_PHASES[number];

export interface ChildWatchdogConfig {
	enabled: boolean;
	runId?: string;
	agent?: string;
	childIndex?: number;
	watchdogTailTimeoutMs: number;
	agentEndTimeoutMs: number;
	maxWarnings: number | null;
	model?: string;
	thinking?: string | false;
	autoFollowBlockers: boolean;
	autoFollowMaxAttempts: number | null;
	stalemateRepeats: number;
}

export interface ChildWatchdogStatusEvent {
	type: typeof CHILD_WATCHDOG_STATUS_EVENT;
	runId?: string;
	agent?: string;
	childIndex?: number;
	stepIndex?: number;
	seq: number;
	phase: ChildWatchdogPhase;
	ts: number;
	followUpPending: boolean;
	reason?: string;
}

export interface ChildWatchdogStateSnapshot {
	phase: ChildWatchdogPhase;
	seq: number;
	lastUpdate: number;
	followUpPending: boolean;
	reason?: string;
	timedOut?: boolean;
}

export function resolveChildWatchdogConfig(input: {
	config: { enabled?: boolean };
	agent?: string;
	runId?: string;
	childIndex?: number;
}): ChildWatchdogConfig | undefined {
	if (!input.config.enabled) return undefined;
	return {
		enabled: true,
		...(input.runId ? { runId: input.runId } : {}),
		...(input.agent ? { agent: input.agent } : {}),
		...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
		watchdogTailTimeoutMs: 120_000,
		agentEndTimeoutMs: 30_000,
		maxWarnings: null,
		autoFollowBlockers: false,
		autoFollowMaxAttempts: null,
		stalemateRepeats: 3,
	};
}

export function encodeChildWatchdogConfig(config: ChildWatchdogConfig | undefined): string | undefined {
	return config ? JSON.stringify(config) : undefined;
}

export function decodeChildWatchdogConfig(raw: string | undefined): ChildWatchdogConfig | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || parsed.enabled === false) return undefined;
		return parsed as unknown as ChildWatchdogConfig;
	} catch {
		return undefined;
	}
}

export function childWatchdogIsActive(snapshot?: ChildWatchdogStateSnapshot): boolean {
	if (!snapshot) return false;
	return snapshot.phase === "reviewing" || snapshot.phase === "autofollow" || snapshot.phase === "settling";
}

export function isChildWatchdogStatusEvent(value: unknown): value is ChildWatchdogStatusEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<ChildWatchdogStatusEvent>;
	return event.type === CHILD_WATCHDOG_STATUS_EVENT
		&& typeof event.seq === "number"
		&& typeof event.phase === "string"
		&& (CHILD_WATCHDOG_PHASES as readonly string[]).includes(event.phase);
}

export function acceptChildWatchdogEvent(input: {
	current?: ChildWatchdogStateSnapshot;
	event: ChildWatchdogStatusEvent;
	runId?: string;
	agent?: string;
	childIndex?: number;
}): ChildWatchdogStateSnapshot | undefined {
	const { event, current } = input;
	if (current && event.seq <= current.seq) return undefined;
	return {
		phase: event.phase,
		seq: event.seq,
		lastUpdate: event.ts,
		followUpPending: event.followUpPending,
		...(event.reason ? { reason: event.reason } : {}),
	};
}

/**
 * Register child watchdog in the child process.
 * This is a lightweight stub — full watchdog review logic (MainWatchdogRuntime)
 * is omitted since it requires complex LSP/review infrastructure not ported.
 * Child watchdog status events are still emitted so the parent can track state.
 */
export function registerChildWatchdog(pi: ExtensionAPI, rawConfig = process.env[CHILD_WATCHDOG_CONFIG_ENV]): void {
	const childConfig = decodeChildWatchdogConfig(rawConfig);
	if (!childConfig?.enabled) return;

	let seq = 0;
	const emitStatus = (phase: ChildWatchdogPhase, followUpPending = false, reason?: string): void => {
		try {
			process.stdout.write(`${JSON.stringify({
				type: CHILD_WATCHDOG_STATUS_EVENT,
				...(childConfig.runId ? { runId: childConfig.runId } : {}),
				...(childConfig.agent ? { agent: childConfig.agent } : {}),
				...(childConfig.childIndex !== undefined ? { childIndex: childConfig.childIndex, stepIndex: childConfig.childIndex } : {}),
				seq: ++seq,
				phase,
				ts: Date.now(),
				followUpPending,
				...(reason ? { reason } : {}),
			})}\n`);
		} catch {
			// Advisory; stdout failures handled by parent.
		}
	};

	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown) => unknown) => void;
	onRuntimeEvent("session_start", () => { emitStatus("idle"); });
	onRuntimeEvent("agent_end", () => { emitStatus("idle"); });
	onRuntimeEvent("session_shutdown", () => { emitStatus("idle"); });
}
