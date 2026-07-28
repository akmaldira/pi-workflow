/**
 * Tests for pi-spawn.ts — Pi CLI command resolution
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findPiPackageRootFromEntry,
	getPiSpawnCommand,
	PI_SUBAGENT_PI_BINARY_ENV,
	resolvePiCliScript,
} from "../extensions/pi-spawn.ts";

describe("pi-spawn", () => {
	describe("findPiPackageRootFromEntry", () => {
		it("should find package root from entry point", () => {
			// Create a temporary directory structure
			const tmpDir = path.join(require("node:os").tmpdir(), "pi-test-pkg");
			const pkgDir = path.join(tmpDir, "node_modules", "@earendil-works", "pi-coding-agent");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
			);

			const entryPoint = path.join(pkgDir, "bin", "pi.js");
			fs.mkdirSync(path.dirname(entryPoint), { recursive: true });
			fs.writeFileSync(entryPoint, "console.log('pi')");

			const result = findPiPackageRootFromEntry(entryPoint);
			expect(result).toBe(pkgDir);

			// Cleanup
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("should return undefined when package root not found", () => {
			const tmpDir = path.join(require("node:os").tmpdir(), "pi-test-no-pkg");
			fs.mkdirSync(tmpDir, { recursive: true });

			const entryPoint = path.join(tmpDir, "some-script.js");
			fs.writeFileSync(entryPoint, "console.log('test')");

			const result = findPiPackageRootFromEntry(entryPoint);
			expect(result).toBeUndefined();

			fs.rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("getPiSpawnCommand", () => {
		const originalEnv = { ...process.env };

		afterEach(() => {
			process.env = { ...originalEnv };
		});

		it("should use PI_SUBAGENT_PI_BINARY env var when set", () => {
			process.env[PI_SUBAGENT_PI_BINARY_ENV] = "/custom/path/to/pi";
			const result = getPiSpawnCommand(["--mode", "json"]);
			expect(result.command).toBe("/custom/path/to/pi");
			expect(result.args).toEqual(["--mode", "json"]);
		});

		it("should fall back to 'pi' when no resolution possible", () => {
			delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
			const result = getPiSpawnCommand(["--mode", "json"]);
			expect(result.command).toBe("pi");
			expect(result.args).toEqual(["--mode", "json"]);
		});

		it("should pass args correctly", () => {
			const result = getPiSpawnCommand(["--mode", "json", "-p", "Task: hello"]);
			expect(result.args).toEqual(["--mode", "json", "-p", "Task: hello"]);
		});
	});

	describe("resolvePiCliScript", () => {
		it("should return undefined when no resolution possible", () => {
			const result = resolvePiCliScript({ argv1: undefined, env: {} });
			expect(result).toBeUndefined();
		});
	});
});
