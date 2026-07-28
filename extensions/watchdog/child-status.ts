/**
 * Watchdog child status — child watchdog configuration and status tracking.
 */

import type { ControlConfig } from "../types.ts";

export interface ChildWatchdogConfig {
	enabled?: boolean;
	activeNoticeAfterMs?: number;
	needsAttentionAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
}

export interface ChildWatchdogStateSnapshot {
	phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed";
	seq: number;
	lastUpdate: number;
	followUpPending: boolean;
	reason?: string;
	timedOut?: boolean;
}

export function resolveChildWatchdogConfig(input: {
	config: { enabled?: boolean; activeNoticeAfterMs?: number; needsAttentionAfterMs?: number };
	agent: string;
	runId: string;
	childIndex: number;
}): ChildWatchdogConfig | undefined {
	if (!input.config.enabled) return undefined;
	return {
		enabled: true,
		activeNoticeAfterMs: input.config.activeNoticeAfterMs,
		needsAttentionAfterMs: input.config.needsAttentionAfterMs,
	};
}

export function childWatchdogIsActive(config?: ChildWatchdogConfig): boolean {
	return config?.enabled ?? false;
}

export function isChildWatchdogStatusEvent(event: any): boolean {
	return event?.type === "child_watchdog_status";
}

export function acceptChildWatchdogEvent(event: any): boolean {
	return event?.type === "child_watchdog_update";
}
