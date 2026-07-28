/**
 * Acceptance system — validates subagent results against configurable
 * acceptance levels (attested, checked, verified) with evidence gathering,
 * criteria checking, and verify commands.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceLedger,
	AcceptanceLevel,
	AcceptanceReport,
	AcceptanceRuntimeCheck,
	AcceptanceRuntimeCheckStatus,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
} from "./types.ts";

const LEVEL_RANK: Record<Exclude<AcceptanceLevel, "auto">, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
};

const VALID_LEVELS = new Set<AcceptanceLevel>(["auto", "none", "attested", "checked", "verified"]);
const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
]);
const ACCEPTANCE_CONFIG_KEYS = new Set(["level", "criteria", "evidence", "verify", "review", "stopRules", "reason"]);
const ACCEPTANCE_GATE_KEYS = new Set(["id", "must", "evidence", "severity"]);
const ACCEPTANCE_VERIFY_KEYS = new Set(["id", "command", "timeoutMs", "cwd", "env", "allowFailure"]);
const ACCEPTANCE_REVIEW_KEYS = new Set(["agent", "focus", "required"]);

function normalizeLevel(level: AcceptanceLevel | undefined): Exclude<AcceptanceLevel, "auto"> | "auto" {
	return level ?? "auto";
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function requiredEvidenceForLevel(level: Exclude<AcceptanceLevel, "auto">): AcceptanceEvidenceKind[] {
	switch (level) {
		case "none":
			return [];
		case "attested":
			return ["manual-notes", "residual-risks"];
		case "checked":
			return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
		case "verified":
			return ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"];
	}
}

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig | undefined {
	if (input === undefined) return undefined;
	if (input === false) return { level: "none", reason: "Acceptance explicitly disabled." };
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input)) throw new Error(`Invalid acceptance level '${input}'. Valid: auto, none, attested, checked, verified.`);
		if (input === "none") return { level: "none", reason: "Acceptance level 'none' requires a reason." };
		return { level: input };
	}
	if (typeof input !== "object" || Array.isArray(input)) throw new Error("Acceptance config must be an object or a level string.");
	for (const key of Object.keys(input)) {
		if (!ACCEPTANCE_CONFIG_KEYS.has(key)) throw new Error(`Unknown acceptance config key '${key}'.`);
	}
	return input;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	if (input === undefined) return [];
	if (input === false) return [];
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input)) return [`Invalid acceptance level '${input}'.`];
		return [];
	}
	if (typeof input !== "object" || Array.isArray(input)) return [`Acceptance must be a level string, false, or an object.`];
	const errors: string[] = [];
	for (const key of Object.keys(input)) {
		if (!ACCEPTANCE_CONFIG_KEYS.has(key)) errors.push(`Unknown acceptance key '${key}'.`);
	}
	const config = input as AcceptanceConfig;
	if (config.level !== undefined && !VALID_LEVELS.has(config.level)) errors.push(`Invalid acceptance level '${config.level}'.`);
	if (config.evidence !== undefined) {
		for (const ev of config.evidence) {
			if (!VALID_EVIDENCE.has(ev)) errors.push(`Invalid acceptance evidence '${ev}'.`);
		}
	}
	if (config.criteria !== undefined) {
		for (const criterion of config.criteria) {
			if (typeof criterion === "string") continue;
			if (typeof criterion !== "object" || Array.isArray(criterion)) {
				errors.push("Acceptance criteria must be strings or objects.");
				continue;
			}
			for (const key of Object.keys(criterion)) {
				if (!ACCEPTANCE_GATE_KEYS.has(key)) errors.push(`Unknown acceptance gate key '${key}'.`);
			}
		}
	}
	if (config.verify !== undefined) {
		for (const verify of config.verify) {
			for (const key of Object.keys(verify)) {
				if (!ACCEPTANCE_VERIFY_KEYS.has(key)) errors.push(`Unknown acceptance verify key '${key}'.`);
			}
		}
	}
	if (config.review !== undefined && config.review !== false) {
		for (const key of Object.keys(config.review)) {
			if (!ACCEPTANCE_REVIEW_KEYS.has(key)) errors.push(`Unknown acceptance review key '${key}'.`);
		}
	}
	return errors;
}

export function resolveEffectiveAcceptance(input: {
	agentName: string;
	acceptance?: AcceptanceInput;
	acceptanceContext?: { mode?: "single" | "parallel" | "chain"; async?: boolean; dynamic?: boolean; dynamicGroup?: boolean };
}): { level: Exclude<AcceptanceLevel, "auto">; explicit: boolean; reasons: string[]; criteria: string[]; evidence: AcceptanceEvidenceKind[]; review?: { agent?: string; required?: boolean } } {
	const agent = input.agentName.toLowerCase();
	const task = "";
	const reasons: string[] = [];

	const config = normalizeAcceptanceInput(input.acceptance);
	if (config?.level && config.level !== "auto") {
		const level = config.level;
		const evidence = unique([...(config.evidence ?? []), ...requiredEvidenceForLevel(level)]);
		const criteria = (config.criteria ?? []).map((c) => (typeof c === "string" ? c : c.must));
		return { level, explicit: true, reasons, criteria, evidence, review: config.review === false ? undefined : config.review };
	}

	// Auto-inference
	const readOnlyAgent = /\b(?:reviewer|oracle|scout|context-builder|researcher|analyst)\b/.test(agent);
	const writeAgent = /\bworker\b/.test(agent);

	if (readOnlyAgent) {
		return { level: "none", explicit: false, reasons: ["Agent name suggests read-only role"], criteria: [], evidence: [] };
	}
	if (writeAgent) {
		return { level: "checked", explicit: false, reasons: ["Agent name suggests writer role"], criteria: [], evidence: requiredEvidenceForLevel("checked") };
	}
	return { level: "none", explicit: false, reasons: ["No explicit acceptance and no heuristic match"], criteria: [], evidence: [] };
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig, options: { reportOptional?: boolean } = {}): string {
	const lines: string[] = [];
	lines.push("## Acceptance");
	lines.push(`Level: ${acceptance.level}`);
	if (acceptance.criteria.length > 0) {
		lines.push("Criteria:");
		for (const criterion of acceptance.criteria) {
			lines.push(`- ${criterion.must}`);
		}
	}
	if (acceptance.evidence.length > 0) {
		lines.push(`Evidence: ${acceptance.evidence.join(", ")}`);
	}
	if (acceptance.verify.length > 0) {
		lines.push("Verify commands:");
		for (const verify of acceptance.verify) {
			lines.push(`- ${verify.command}`);
		}
	}
	return lines.join("\n");
}

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const marker = "---ACCEPTANCE_REPORT---";
	const idx = output.indexOf(marker);
	if (idx === -1) return {};
	const reportText = output.slice(idx + marker.length).trim();
	try {
		return { report: JSON.parse(reportText) as AcceptanceReport };
	} catch (error) {
		return { error: `Failed to parse acceptance report: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function stripAcceptanceReport(output: string): string {
	const marker = "---ACCEPTANCE_REPORT---";
	const idx = output.indexOf(marker);
	if (idx === -1) return output;
	return output.slice(0, idx).trim();
}

export function buildSkippedAcceptanceLedger(acceptance: ResolvedAcceptanceConfig, input: { id: string; message: string }): AcceptanceLedger {
	return {
		status: "not-required",
		evidenceStatus: "not-required",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status === "accepted") return undefined;
	if (ledger.status === "rejected") return "Acceptance was rejected.";
	return `Acceptance not met: ${ledger.status}`;
}

export function buildPendingAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	return {
		status: "pending",
		evidenceStatus: "pending",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd?: string;
}): Promise<AcceptanceLedger> {
	const ledger = buildPendingAcceptanceLedger(input.acceptance);

	// Parse acceptance report from output
	const { report, error } = parseAcceptanceReport(input.output);
	if (report) {
		ledger.childReport = report;
	} else if (error) {
		ledger.childReportParseError = error;
	}

	// Run verify commands
	for (const verify of input.acceptance.verify) {
		const result = await runVerifyCommand(verify, input.cwd);
		ledger.verifyRuns.push(result);
	}

	// Evaluate criteria
	const criteriaSatisfied = report?.criteriaSatisfied ?? [];
	const satisfiedIds = new Set(criteriaSatisfied.map((c) => c.id).filter(Boolean));
	for (const criterion of input.acceptance.criteria) {
		const satisfied = criterion.id ? satisfiedIds.has(criterion.id) : criteriaSatisfied.some((c) => c.evidence.includes(criterion.must));
		if (!satisfied && criterion.severity === "required") {
			ledger.status = "rejected";
		}
	}

	// Determine final status
	if (ledger.status !== "rejected") {
		const allRequiredMet = input.acceptance.criteria
			.filter((c) => c.severity === "required")
			.every((c) => {
				if (c.id) return satisfiedIds.has(c.id);
				return criteriaSatisfied.some((cs) => cs.evidence.includes(c.must));
			});
		ledger.status = allRequiredMet ? "accepted" : "pending";
	}

	return ledger;
}

async function runVerifyCommand(verify: AcceptanceVerifyCommand, cwd?: string): Promise<AcceptanceVerifyResult> {
	const timeout = verify.timeoutMs ?? 30000;
	const env = { ...process.env, ...(verify.env ?? {}) };
	try {
		const result = spawnSync(verify.command, {
			cwd: verify.cwd ?? cwd,
			env,
			timeout,
			shell: true,
			encoding: "utf-8",
		});
		return {
			id: verify.id,
			command: verify.command,
			cwd: verify.cwd ?? cwd,
			exitCode: result.status ?? null,
			status: result.status === 0 ? "passed" : "failed",
			stdout: result.stdout,
			stderr: result.stderr,
			durationMs: result.status !== null ? timeout : 0,
		};
	} catch (error) {
		return {
			id: verify.id,
			command: verify.command,
			cwd: verify.cwd ?? cwd,
			exitCode: null,
			status: "failed",
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			durationMs: timeout,
		};
	}
}
