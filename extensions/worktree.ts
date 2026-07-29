/**
 * Git worktree isolation for workflow subagents.
 *
 * When an agent() call requests `isolation: 'worktree'`, the subagent runs in a
 * throwaway git worktree on a detached branch so parallel file-mutating agents
 * don't clobber each other. After the agent finishes we capture a diff; a
 * worktree with no changes is removed immediately ("auto-removed if unchanged").
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Worktree {
	path: string;
	/** cwd the subagent should use (worktree root joined with the original relative cwd). */
	agentCwd: string;
	branch: string;
	baseCommit: string;
}

export interface WorktreeDiff {
	filesChanged: number;
	insertions: number;
	deletions: number;
	diffStat: string;
	patch: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

/** Like tryGit but does NOT `.trim()` — required for `git diff --binary` output,
 *  whose trailing blank lines are part of the patch format and must not be stripped. */
function tryGitRaw(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return undefined;
	}
}

export function isGitRepo(cwd: string): boolean {
	return tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * Create an isolated worktree for one subagent. Throws if `cwd` is not inside a
 * git repository (the caller falls back to a shared cwd in that case).
 */
export function createWorktree(cwd: string, runId: string, index: number): Worktree {
	const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) throw new Error("isolation: 'worktree' requires the working directory to be inside a git repository");

	const baseCommit = tryGit(cwd, ["rev-parse", "HEAD"]) ?? "";
	if (!baseCommit) {
		throw new Error("isolation: 'worktree' requires at least one commit in the repository");
	}

	const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
	const branch = `ultracode/${safeRun}-${index}`;
	const worktreePath = path.join(os.tmpdir(), `ultracode-wt-${safeRun}-${index}`);

	// Best-effort GC of orphaned + stale ultracode worktrees from earlier runs.
	// Rate-limited so a fleet of worktree agents doesn't hammer tmpdir on every create.
	const _now = Date.now();
	if (_now - lastReapAt > REAP_INTERVAL_MS) {
		lastReapAt = _now;
		reapStaleWorktrees(toplevel);
	}

	// Clean up any stale worktree from a crashed prior run.
	removeWorktreeQuiet(toplevel, worktreePath, branch);

	git(toplevel, ["worktree", "add", "--detach", worktreePath, baseCommit]);
	// Move onto a named branch so the diff has a stable ref and cleanup is unambiguous.
	tryGit(worktreePath, ["checkout", "-B", branch]);

	linkNodeModules(toplevel, worktreePath);

	const relativeCwd = path.relative(toplevel, path.resolve(cwd));
	const agentCwd =
		relativeCwd && !relativeCwd.startsWith("..") ? path.join(worktreePath, relativeCwd) : worktreePath;

	return { path: worktreePath, agentCwd, branch, baseCommit };
}

/** Stage everything and capture the diff vs the base commit. */
export function captureWorktreeDiff(worktree: Worktree): WorktreeDiff {
	tryGit(worktree.path, ["add", "-A"]);

	const diffStat = tryGit(worktree.path, ["diff", "--cached", "--stat", worktree.baseCommit]) ?? "";
	const patch = tryGitRaw(worktree.path, ["diff", "--cached", worktree.baseCommit]) ?? "";

	const lines = diffStat.split("\n");
	let filesChanged = 0,
		insertions = 0,
		deletions = 0;

	for (const line of lines) {
		const match = line.match(/^.+?\s+(\d+)\s+\+*(\d*)\s*-*(\d*)\s*$/);
		if (match) {
			filesChanged++;
			insertions += parseInt(match[2] || "0", 10);
			deletions += parseInt(match[3] || "0", 10);
		}
	}

	return { filesChanged, insertions, deletions, diffStat, patch };
}

/** Check if a worktree diff is empty (no changes). */
export function isEmptyDiff(diff: WorktreeDiff): boolean {
	return diff.filesChanged === 0 && diff.insertions === 0 && diff.deletions === 0;
}

/** Remove a worktree (best-effort). */
export function removeWorktree(toplevel: string, worktreePath: string, branch: string): void {
	tryGit(toplevel, ["worktree", "remove", "--force", worktreePath]);
	tryGit(toplevel, ["branch", "-D", branch]);
	fs.rmSync(worktreePath, { recursive: true, force: true });
}

function removeWorktreeQuiet(toplevel: string, worktreePath: string, branch: string): void {
	try {
		removeWorktree(toplevel, worktreePath, branch);
	} catch {
		// ignore
	}
}

/** Symlink node_modules from main repo into worktree (speed optimization). */
function linkNodeModules(toplevel: string, worktreePath: string): void {
	const srcModules = path.join(toplevel, "node_modules");
	const dstModules = path.join(worktreePath, "node_modules");

	if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
		try {
			fs.symlinkSync(srcModules, dstModules, "dir");
		} catch {
			// If symlink fails, ignore (e.g., windows without admin, or permission denied)
		}
	}
}

let lastReapAt = 0;
const REAP_INTERVAL_MS = 30000; // Rate-limit GC to every 30 seconds

/** Clean up stale worktrees from crashed runs (best-effort). */
function reapStaleWorktrees(toplevel: string): void {
	try {
		const tmpdir = os.tmpdir();
		const entries = fs.readdirSync(tmpdir);

		for (const entry of entries) {
			if (entry.startsWith("ultracode-wt-")) {
				const fullPath = path.join(tmpdir, entry);
				const stats = fs.statSync(fullPath);
				const ageMs = Date.now() - stats.mtimeMs;

				// Remove if older than 24 hours
				if (ageMs > 24 * 60 * 60 * 1000) {
					fs.rmSync(fullPath, { recursive: true, force: true });
				}
			}
		}
	} catch {
		// Ignore GC failures
	}
}

/** Clean up all worktrees created for a specific run (call on workflow exit). */
export function cleanupWorktrees(cwd: string, runId: string): void {
	if (!isGitRepo(cwd)) return;

	const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) return;

	const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
	const wtDirPrefix = `ultracode-wt-${safeRun}-`;

	try {
		const tmpdir = os.tmpdir();
		const entries = fs.readdirSync(tmpdir);

		for (const entry of entries) {
			if (entry.startsWith(wtDirPrefix)) {
				const fullPath = path.join(tmpdir, entry);
				fs.rmSync(fullPath, { recursive: true, force: true });
			}
		}
	} catch {
		// ignore
	}
}
