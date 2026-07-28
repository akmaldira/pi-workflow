/**
 * Optional model-scope enforcement for subagent model resolution.
 *
 * When `subagents.modelScope.enforce` is enabled, a resolved model that does not
 * match any `allow` pattern is rejected. The severity depends on where the
 * model came from: an explicit caller-supplied model is a hard error, while a
 * model inherited from agent frontmatter / the parent session only emits a
 * warning.
 */

import { splitKnownThinkingSuffix } from "./model-info.ts";

export interface ModelScopeConfig {
	enforce?: boolean;
	/** Glob-style allow patterns (only `*` is special), matched against `provider/id`. */
	allow?: string[];
}

/** Where a resolved model originated, deciding enforcement severity. */
export type ModelSource = "explicit" | "inherited";

export interface ModelScopeViolation {
	model: string;
	severity: "warn" | "error";
	message: string;
	allowedPatterns: string[];
}

function stripThinkingSuffix(model: string): string {
	return splitKnownThinkingSuffix(model).baseModel;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function matchesScopePattern(model: string, pattern: string): boolean {
	return globToRegExp(pattern).test(stripThinkingSuffix(model));
}

export function checkModelScope(
	model: string | undefined,
	scope: ModelScopeConfig | undefined,
	source: ModelSource,
): ModelScopeViolation | undefined {
	if (!model || !scope?.enforce) return undefined;
	const allow = scope.allow;
	if (!allow || allow.length === 0) return undefined;
	if (allow.some((pattern) => matchesScopePattern(model, pattern))) return undefined;

	const baseModel = stripThinkingSuffix(model);
	const severity: ModelScopeViolation["severity"] = source === "explicit" ? "error" : "warn";
	return {
		model: baseModel,
		severity,
		allowedPatterns: allow,
		message:
			`Model '${baseModel}' is outside the configured subagent model scope. ` +
			`Allowed patterns: ${allow.join(", ")}.`,
	};
}

export function parseModelScopeConfig(
	value: unknown,
	meta: { filePath: string },
): ModelScopeConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope'; expected an object.`);
	}

	const input = value as Record<string, unknown>;
	const config: ModelScopeConfig = {};

	if ("enforce" in input) {
		if (typeof input.enforce !== "boolean") {
			throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.enforce'; expected a boolean.`);
		}
		config.enforce = input.enforce;
	}

	if ("allow" in input) {
		if (!Array.isArray(input.allow)) {
			throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected an array of strings.`);
		}
		const allow: string[] = [];
		for (const entry of input.allow) {
			if (typeof entry !== "string") {
				throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected an array of strings.`);
			}
			const trimmed = entry.trim();
			if (trimmed) allow.push(trimmed);
		}
		if (allow.length === 0) {
			throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected a non-empty array of patterns.`);
		}
		config.allow = allow;
	}

	if (config.enforce === true && (!config.allow || config.allow.length === 0)) {
		throw new Error(`Subagent settings in '${meta.filePath}' set modelScope.enforce without a non-empty 'allow' list; supply allowed model patterns or disable enforcement.`);
	}

	return Object.keys(config).length > 0 ? config : undefined;
}
