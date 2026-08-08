/**
 * Filesystem channel for child→parent IPC.
 *
 * Children are separate OS processes — they share no memory with the parent
 * extension host. The only viable cross-process transport is the filesystem.
 *
 * Layout:
 *   .pi-workflow/channels/<runId>/
 *     requests/<uuid>.json    — child writes, parent reads + deletes
 *     replies/<uuid>.json     — parent writes, child polls + deletes
 *
 * Every file is written atomically (write to .tmp, rename) so a poller never
 * sees a half-written request.
 *
 * The channel directory is passed to children via the
 * `PI_WORKFLOW_CHANNEL_DIR` environment variable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const PI_WORKFLOW_CHANNEL_DIR_ENV = "PI_WORKFLOW_CHANNEL_DIR";
export const PI_WORKFLOW_RUN_ID_ENV = "PI_WORKFLOW_RUN_ID";

// ── Layout ──────────────────────────────────────────────────────────────

export function channelDir(projectDir: string, runId: string): string {
	return path.join(projectDir, ".pi-workflow", "channels", runId);
}

function requestsDir(dir: string): string {
	return path.join(dir, "requests");
}

function repliesDir(dir: string): string {
	return path.join(dir, "replies");
}

export function ensureChannel(dir: string): void {
	fs.mkdirSync(requestsDir(dir), { recursive: true });
	fs.mkdirSync(repliesDir(dir), { recursive: true });
}

// ── Atomic JSON ─────────────────────────────────────────────────────────

function writeAtomicJson(filePath: string, data: unknown): void {
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
	fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

// ── Request / Reply types ───────────────────────────────────────────────

export interface ChannelRequest {
	type: "channel.request";
	id: string;
	createdAt: number;
	runId: string;
	nodeId?: string;
	agent?: string;
	kind: "human" | "supervisor";
	question: string;
	options?: Array<{ label: string; description?: string }>;
	expectsReply: boolean;
	default?: string;
}

export interface ChannelReply {
	type: "channel.reply";
	requestId: string;
	createdAt: number;
	source: string;
	answer?: string;
	reason?: string;
}

// ── Child side: write requests, poll for replies ────────────────────────

/**
 * Child-side client. Used by `ask_human` and `ask_supervisor` tool
 * implementations running inside a subagent process.
 */
export class ChannelClient {
	readonly dir: string;
	readonly runId: string;

	constructor(dir: string, runId: string) {
		this.dir = dir;
		this.runId = runId;
		ensureChannel(dir);
	}

	/**
	 * Creates a client from env vars. Returns null when the env is not set
	 * (the agent is not running inside a workflow).
	 */
	static fromEnv(): ChannelClient | null {
		const dir = process.env[PI_WORKFLOW_CHANNEL_DIR_ENV];
		const runId = process.env[PI_WORKFLOW_RUN_ID_ENV];
		if (!dir || !runId) return null;
		return new ChannelClient(dir, runId);
	}

	/**
	 * Sends a question and waits for a reply. Blocks the calling tool.
	 *
	 * `pollMs` and `timeoutMs` are tuneable for tests; in production the
	 * supervisor-side expiry (10 min) is the real bound.
	 */
	async ask(
		request: Omit<ChannelRequest, "type" | "id" | "createdAt" | "runId">,
		options: { pollMs?: number; timeoutMs?: number } = {},
	): Promise<ChannelReply> {
		const id = randomUUID();
		const full: ChannelRequest = {
			type: "channel.request",
			id,
			createdAt: Date.now(),
			runId: this.runId,
			...request,
		};

		writeAtomicJson(path.join(requestsDir(this.dir), `${id}.json`), full);

		const pollMs = options.pollMs ?? 500;
		const timeoutMs = options.timeoutMs ?? 11 * 60 * 1000; // slightly past supervisor expiry
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const replyFile = path.join(repliesDir(this.dir), `${id}.json`);
			const reply = readJson<ChannelReply>(replyFile);
			if (reply) {
				try {
					fs.unlinkSync(replyFile);
				} catch {
					/* best effort */
				}
				return reply;
			}
			await sleep(pollMs);
		}

		return {
			type: "channel.reply",
			requestId: id,
			createdAt: Date.now(),
			source: "timeout",
			reason: "No reply received within the timeout period.",
		};
	}
}

// ── Parent side: poll for requests, write replies ───────────────────────

export interface ParentPollerOptions {
	/** Handler called for each incoming request. */
	onRequest: (request: ChannelRequest) => void;
	/** Polling interval. Default 500ms. */
	pollMs?: number;
}

/**
 * Parent-side poller. Scans the requests directory, calls the handler for
 * each new file, and deletes it so it is not re-processed.
 */
export class ChannelPoller {
	private readonly dir: string;
	private readonly onRequest: (request: ChannelRequest) => void;
	private readonly pollMs: number;
	private interval: ReturnType<typeof setInterval> | null = null;
	private seen = new Set<string>();

	constructor(dir: string, options: ParentPollerOptions) {
		this.dir = dir;
		this.onRequest = options.onRequest;
		this.pollMs = options.pollMs ?? 500;
	}

	start(): void {
		if (this.interval) return;
		this.interval = setInterval(() => this.poll(), this.pollMs);
		this.interval.unref?.();
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** Exposed for tests: run one poll cycle synchronously. */
	poll(): void {
		const dir = requestsDir(this.dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // Directory not yet created; that's fine.
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			if (this.seen.has(entry.name)) continue;

			const filePath = path.join(dir, entry.name);
			const request = readJson<ChannelRequest>(filePath);
			if (!request) continue;

			this.seen.add(entry.name);
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* best effort */
			}
			this.onRequest(request);
		}
	}

	/**
	 * Writes a reply for a request. The child polls for this file.
	 */
	reply(requestId: string, reply: Omit<ChannelReply, "type" | "requestId" | "createdAt">): void {
		const full: ChannelReply = {
			type: "channel.reply",
			requestId,
			createdAt: Date.now(),
			...reply,
		};
		writeAtomicJson(path.join(repliesDir(this.dir), `${requestId}.json`), full);
	}
}

// ── Cleanup ─────────────────────────────────────────────────────────────

/**
 * Removes a run's channel directory. Called when a run finishes normally.
 */
export function cleanupChannel(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Startup sweep: cleans up orphaned channel directories left by crashed
 * runs. Called once when the extension loads.
 */
export function sweepOrphanedChannels(projectDir: string): void {
	const channelsRoot = path.join(projectDir, ".pi-workflow", "channels");
	try {
		const entries = fs.readdirSync(channelsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(channelsRoot, entry.name);
			cleanupChannel(dir);
		}
	} catch {
		/* channels dir doesn't exist yet — nothing to sweep */
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
