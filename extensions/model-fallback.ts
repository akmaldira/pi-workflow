/**
 * Model fallback resolution with fuzzy matching and scope enforcement.
 */

import type { ModelInfo as AvailableModelInfo } from "./model-info.ts";
import type { Usage } from "./types.ts";
import { checkModelScope, type ModelScopeConfig, type ModelSource } from "./model-scope.ts";

export type { AvailableModelInfo };

export const INHERIT_MODEL = "inherit";

export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	if (baseModel.includes("/")) {
		const exact = availableModels.find((entry) => entry.fullId === baseModel);
		if (exact) return exact.fullId;
	} else {
		const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
		if (preferredProvider) {
			const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
			if (preferredMatch) return preferredMatch.fullId;
		}
		if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	let queryProvider: string | undefined;
	let queryIdRaw = baseModel;
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
		queryIdRaw = baseModel.slice(slashIdx + 1);
	} else {
		const providerSeparators = [":", "."];
		for (const separator of providerSeparators) {
			const separatorIdx = baseModel.indexOf(separator);
			if (separatorIdx <= 0) continue;
			const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
			if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart)) continue;
			queryProvider = providerPart;
			queryIdRaw = baseModel.slice(separatorIdx + 1);
			break;
		}
	}
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return model;
	const suffix = model.substring(colonIdx + 1);
	if (!["low", "medium", "high", "max", "xhigh", "off", "minimal"].includes(suffix)) return model;
	const baseModel = model.substring(0, colonIdx);
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}:${suffix}`;
	return model;
}

export interface ResolveSubagentModelOverrideOptions {
	scope?: ModelScopeConfig;
	source?: ModelSource;
	onWarn?: (violation: ModelScopeViolation) => void;
}

interface ModelScopeViolation {
	model: string;
	severity: "warn" | "error";
	message: string;
	allowedPatterns: string[];
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-workflow] ${violation.message}`);
}

export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	let resolved: string | undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
	}
	if (resolved && options?.scope?.enforce) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		const violation = checkModelScope(resolved, options.scope, source);
		if (violation) {
			if (violation.severity === "error") throw new Error(violation.message);
			(options.onWarn ?? defaultScopeWarn)(violation);
		}
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: Omit<ResolveSubagentModelOverrideOptions, "source">,
): string | undefined {
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: explicitModel !== undefined ? "explicit" : "inherited" },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: "inherited" },
	);
}

export interface BuildModelCandidatesOptions {
	scope?: ModelScopeConfig;
	onWarn?: (violation: ModelScopeViolation) => void;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		if (index > 0 && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "inherited");
			if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/stream ended without finish_reason/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/cold.?start/i,
	/empty response/i,
	/no output/i,
	/model.*(?:load|fail|error)/i,
];

const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}
