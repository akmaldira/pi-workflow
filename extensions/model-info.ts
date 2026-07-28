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
	if (configThinking === false) return undefined;
	return configThinking;
}

export function findModelInfo(model: string | undefined, availableModels: ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined {
	if (!model || !availableModels?.length) return undefined;

	// Exact match on fullId
	const exact = availableModels.find((entry) => entry.fullId === model);
	if (exact) return exact;

	// Exact match on id (with optional provider preference)
	const exactMatches = availableModels.filter((entry) => entry.id === model);
	if (preferredProvider) {
		const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return preferredMatch;
	}
	if (exactMatches.length === 1) return exactMatches[0];

	return undefined;
}
