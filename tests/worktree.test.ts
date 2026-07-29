import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
	isGitRepo,
	createWorktree,
	captureWorktreeDiff,
	removeWorktree,
	cleanupWorktrees,
	isEmptyDiff,
} from "../extensions/worktree.ts";

describe("Git Worktree Isolation", () => {
	let tempRepo: string;

	beforeEach(() => {
		// Create a temporary git repository for testing
		tempRepo = path.join(os.tmpdir(), `worktree-test-${Date.now()}`);
		fs.mkdirSync(tempRepo, { recursive: true });

		// Initialize git repo
		execSync("git init", { cwd: tempRepo });
		execSync('git config user.email "test@test.com"', { cwd: tempRepo });
		execSync('git config user.name "Test"', { cwd: tempRepo });

		// Create initial commit
		fs.writeFileSync(path.join(tempRepo, "README.md"), "# Test Repo\n");
		execSync("git add README.md", { cwd: tempRepo });
		execSync('git commit -m "initial"', { cwd: tempRepo });
	});

	afterEach(() => {
		if (fs.existsSync(tempRepo)) {
			fs.rmSync(tempRepo, { recursive: true, force: true });
		}
	});

	describe("isGitRepo", () => {
		it("returns true for git repository", () => {
			expect(isGitRepo(tempRepo)).toBe(true);
		});

		it("returns false for non-git directory", () => {
			const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
			fs.mkdirSync(nonGitDir, { recursive: true });
			try {
				expect(isGitRepo(nonGitDir)).toBe(false);
			} finally {
				fs.rmSync(nonGitDir, { recursive: true, force: true });
			}
		});

		it("returns false for non-existent directory", () => {
			expect(isGitRepo("/nonexistent/path")).toBe(false);
		});
	});

	describe("createWorktree", () => {
		it("creates a worktree directory", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			expect(fs.existsSync(worktree.path)).toBe(true);
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run");
		});

		it("sets agentCwd to worktree path", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			expect(worktree.agentCwd).toContain("ultracode-wt-test-run-0");
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run");
		});

		it("creates a detached branch", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			const branches = execSync("git branch -a", { cwd: worktree.path, encoding: "utf8" });
			expect(branches).toContain("ultracode/test-run-0");
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run");
		});

		it("throws if not in git repository", () => {
			const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
			fs.mkdirSync(nonGitDir, { recursive: true });
			try {
				expect(() => createWorktree(nonGitDir, "test-run", 0)).toThrow();
			} finally {
				fs.rmSync(nonGitDir, { recursive: true, force: true });
			}
		});

		it("throws if no prior commits", () => {
			const emptyRepo = path.join(os.tmpdir(), `empty-repo-${Date.now()}`);
			fs.mkdirSync(emptyRepo, { recursive: true });
			try {
				execSync("git init", { cwd: emptyRepo });
				execSync('git config user.email "test@test.com"', { cwd: emptyRepo });
				execSync('git config user.name "Test"', { cwd: emptyRepo });

				expect(() => createWorktree(emptyRepo, "test-run", 0)).toThrow();
			} finally {
				fs.rmSync(emptyRepo, { recursive: true, force: true });
			}
		});

		it("handles special characters in runId", () => {
			const worktree = createWorktree(tempRepo, "test-run-with-@#$%", 0);
			expect(fs.existsSync(worktree.path)).toBe(true);
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run-with-@#$%");
		});
	});

	describe("captureWorktreeDiff", () => {
		it("captures empty diff when no changes", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			const diff = captureWorktreeDiff(worktree);

			expect(diff.filesChanged).toBe(0);
			expect(diff.insertions).toBe(0);
			expect(diff.deletions).toBe(0);
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run");
		});

		it("includes diffStat and patch fields", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			fs.writeFileSync(path.join(worktree.path, "newfile.txt"), "content");

			const diff = captureWorktreeDiff(worktree);
			expect(typeof diff.diffStat).toBe("string");
			expect(typeof diff.patch).toBe("string");
			// Cleanup
			cleanupWorktrees(tempRepo, "test-run");
		});
	});

	describe("isEmptyDiff", () => {
		it("returns true for no changes", () => {
			const diff = { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "", patch: "" };
			expect(isEmptyDiff(diff)).toBe(true);
		});

		it("returns false when files changed", () => {
			const diff = { filesChanged: 1, insertions: 0, deletions: 0, diffStat: "", patch: "" };
			expect(isEmptyDiff(diff)).toBe(false);
		});

		it("returns false when insertions", () => {
			const diff = { filesChanged: 0, insertions: 5, deletions: 0, diffStat: "", patch: "" };
			expect(isEmptyDiff(diff)).toBe(false);
		});

		it("returns false when deletions", () => {
			const diff = { filesChanged: 0, insertions: 0, deletions: 3, diffStat: "", patch: "" };
			expect(isEmptyDiff(diff)).toBe(false);
		});
	});

	describe("removeWorktree", () => {
		it("removes worktree directory", () => {
			const worktree = createWorktree(tempRepo, "test-run", 0);
			const wtPath = worktree.path;
			expect(fs.existsSync(wtPath)).toBe(true);

			removeWorktree(tempRepo, wtPath, worktree.branch);
			expect(fs.existsSync(wtPath)).toBe(false);
		});

		it("removes git branch", () => {
			const worktree = createWorktree(tempRepo, "test-run-br", 0);
			removeWorktree(tempRepo, worktree.path, worktree.branch);

			const branches = execSync("git branch", { cwd: tempRepo, encoding: "utf8" });
			expect(branches).not.toContain(worktree.branch);
		});
	});

	describe("cleanupWorktrees", () => {
		it("cleans up all worktrees for a runId", () => {
			const wt1 = createWorktree(tempRepo, "cleanup-test", 0);
			const wt2 = createWorktree(tempRepo, "cleanup-test", 1);

			const path1 = wt1.path;
			const path2 = wt2.path;

			expect(fs.existsSync(path1)).toBe(true);
			expect(fs.existsSync(path2)).toBe(true);

			cleanupWorktrees(tempRepo, "cleanup-test");

			// All should be cleaned
			expect(fs.existsSync(path1)).toBe(false);
			expect(fs.existsSync(path2)).toBe(false);
		});

		it("does nothing if not in git repo", () => {
			const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
			fs.mkdirSync(nonGitDir, { recursive: true });
			try {
				// Should not throw
				cleanupWorktrees(nonGitDir, "test-run");
				expect(true).toBe(true);
			} finally {
				fs.rmSync(nonGitDir, { recursive: true, force: true });
			}
		});
	});

	describe("Full worktree lifecycle", () => {
		it("create and cleanup workflow", () => {
			const runId = "lifecycle-test";

			// Create worktree
			const worktree = createWorktree(tempRepo, runId, 0);
			expect(fs.existsSync(worktree.path)).toBe(true);

			// Capture diff
			const diff = captureWorktreeDiff(worktree);
			expect(typeof diff.filesChanged).toBe("number");

			// Cleanup
			cleanupWorktrees(tempRepo, runId);
			expect(fs.existsSync(worktree.path)).toBe(false);
		});
	});
});
