/**
 * Subagent control — control event tracking and notification for long-running
 * and needs-attention states.
 */

import type { ControlConfig, ControlEvent, ResolvedControlConfig } from "./types.ts";

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 300000,
	activeNoticeAfterMs: 240000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: ["active_long_running", "needs_attention"],
	notifyChannels: ["event", "async"],
};

export function resolveControlConfig(config?: ControlConfig): { ok: boolean; config: ResolvedControlConfig } {
	if (!config) return { ok: true, config: DEFAULT_CONTROL_CONFIG };
	return {
		ok: true,
		config: {
			enabled: config.enabled ?? true,
			needsAttentionAfterMs: config.needsAttentionAfterMs ?? 300000,
			activeNoticeAfterMs: config.activeNoticeAfterMs ?? 240000,
			activeNoticeAfterTurns: config.activeNoticeAfterTurns,
			activeNoticeAfterTokens: config.activeNoticeAfterTokens,
			failedToolAttemptsBeforeAttention: config.failedToolAttemptsBeforeAttention ?? 3,
			notifyOn: config.notifyOn ?? ["active_long_running", "needs_attention"],
			notifyChannels: config.notifyChannels ?? ["event", "async"],
		},
	};
}

export function buildControlEvent(event: Partial<ControlEvent>): ControlEvent {
	return {
		type: event.type ?? "needs_attention",
		from: event.from,
		to: event.to ?? "needs_attention",
		ts: event.ts ?? Date.now(),
		agent: event.agent ?? "unknown",
		index: event.index,
		runId: event.runId ?? "unknown",
		message: event.message ?? "",
		reason: event.reason,
		turns: event.turns,
		tokens: event.tokens,
		toolCount: event.toolCount,
		currentTool: event.currentTool,
		currentToolDurationMs: event.currentToolDurationMs,
		currentPath: event.currentPath,
		elapsedMs: event.elapsedMs,
		recentFailureSummary: event.recentFailureSummary,
	};
}

export function claimControlNotification(
	config: ResolvedControlConfig,
	event: ControlEvent,
	emittedKeys: Set<string>,
): boolean {
	const key = `${event.type}:${event.agent}:${event.runId}`;
	if (emittedKeys.has(key)) return false;
	emittedKeys.add(key);
	return true;
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	if (!config.enabled) return false;
	return config.notifyOn.includes(event.type);
}

export function deriveActivityState(
	progress: { lastActivityAt?: number; toolCount: number; turnCount?: number },
	config: ResolvedControlConfig,
): "active_long_running" | "needs_attention" | undefined {
	if (!progress.lastActivityAt) return undefined;
	const elapsed = Date.now() - progress.lastActivityAt;
	if (elapsed > config.activeNoticeAfterMs) return "active_long_running";
	if (elapsed > config.needsAttentionAfterMs) return "needs_attention";
	return undefined;
}
