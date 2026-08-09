/**
 * Artifact management — stores input/output/jsonl/transcript/metadata files
 * for subagent runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactConfig, ArtifactPaths } from "./types.ts";

export function getProjectSubagentsDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow");
}

export function getProjectArtifactsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "artifacts");
}

export function getArtifactsDir(
	baseDir: string,
	runId: string,
	agent: string,
	index?: number,
): string {
	const safeAgent = agent.replace(/[^\w.-]+/g, "_");
	const suffix = index !== undefined ? `-${index}` : "";
	return path.join(baseDir, "runs", `${runId}-${safeAgent}${suffix}`);
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const safeAgent = agent.replace(/[^\w.-]+/g, "_");
	const suffix = index !== undefined ? `-${index}` : "";
	const base = path.join(artifactsDir, "runs", `${runId}-${safeAgent}${suffix}`);
	return {
		inputPath: path.join(base, "input.md"),
		outputPath: path.join(base, "output.md"),
		jsonlPath: path.join(base, "events.jsonl"),
		transcriptPath: path.join(base, "transcript.jsonl"),
		metadataPath: path.join(base, "metadata.json"),
	};
}

export function ensureArtifactsDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

export function formatOutputArtifactContent(input: {
	output: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}): string {
	if (!input.truncated) return input.output;
	const parts = [input.output];
	if (input.originalBytes !== undefined) parts.push(`<!-- original bytes: ${input.originalBytes} -->`);
	if (input.originalLines !== undefined) parts.push(`<!-- original lines: ${input.originalLines} -->`);
	if (input.artifactPath) parts.push(`<!-- full output at ${input.artifactPath} -->`);
	return parts.join("\n");
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, line + "\n", "utf-8");
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const fullPath = path.join(dir, entry.name);
		try {
			const stat = fs.statSync(fullPath);
			if (stat.mtimeMs < cutoff) {
				fs.rmSync(fullPath, { recursive: true, force: true });
			}
		} catch {
			// Best-effort cleanup
		}
	}
}
