/**
 * Model resolution and thinking-level helpers.
 */

export const THINKING_LEVELS = ["low", "medium", "high", "max", "xhigh", "off", "minimal"] as const;

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
}

export interface SplitThinkingSuffixResult {
	baseModel: string;
	thinkingSuffix: string;
}

export function splitKnownThinkingSuffix(model: string): SplitThinkingSuffixResult {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = model.substring(colonIdx + 1);
	if (THINKING_LEVELS.some((level) => level === suffix)) {
		return { baseModel: model.substring(0, colonIdx), thinkingSuffix: model.substring(colonIdx) };
	}
	return { baseModel: model, thinkingSuffix: "" };
}

export function resolveEffectiveThinking(model: string | undefined, configThinking: string | false | undefined): string | undefined {
	if (!configThinking) return undefined;
	return configThinking;
}
