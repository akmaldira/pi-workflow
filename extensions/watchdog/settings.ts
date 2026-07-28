/**
 * Watchdog settings — configuration for per-run watchdog monitoring.
 */

import type { ControlConfig } from "../types.ts";

export interface WatchdogConfig {
	enabled?: boolean;
	activeNoticeAfterMs?: number;
	needsAttentionAfterMs?: number;
}

export function resolveWatchdogConfig(cwd: string): { ok: boolean; config: WatchdogConfig } {
	return { ok: true, config: { enabled: true, activeNoticeAfterMs: 240000, needsAttentionAfterMs: 300000 } };
}
