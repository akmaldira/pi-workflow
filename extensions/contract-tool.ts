/**
 * contract tool — create, get, list, edit, propose, supersede contracts
 * stored as Markdown files with YAML frontmatter under .pi-workflow/contracts/.
 *
 * Each file: .pi-workflow/contracts/<id>.md
 *
 * Frontmatter fields:
 *   id, type, status, producer, consumer, created, updated, version,
 *   supersedes? (id of the contract this one replaces)
 *
 * Lifecycle:  draft → proposed → (approved / rejected)  [v1: no approve/reject]
 * Immutability: edit is only allowed on draft contracts.
 * Supersede: creates a new version, marks old as superseded.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

export type ContractType = "api" | "interface" | "task" | "data" | "other";
export type ContractStatus = "draft" | "proposed" | "superseded";

export interface ContractMeta {
	id: string;
	type: ContractType;
	status: ContractStatus;
	producer: string;
	consumer: string;
	created: string;
	updated: string;
	version: number;
	supersedes?: string;
	sizeBytes: number;
	/** First H1 heading extracted from the body */
	title: string;
}

// ── Directory helpers ────────────────────────────────────────────────────

export function contractsDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow", "contracts");
}

function ensureContractsDir(cwd: string): string {
	const dir = contractsDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ── ID / slug ────────────────────────────────────────────────────────────

export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "contract";
}

export function uniqueContractId(cwd: string, name: string): string {
	const dir = contractsDir(cwd);
	const base = slugify(name);
	if (!fs.existsSync(path.join(dir, `${base}.md`))) return base;
	return `${base}-${Date.now()}`;
}

// ── Frontmatter serialisation ────────────────────────────────────────────

function serializeFrontmatter(meta: Omit<ContractMeta, "sizeBytes" | "title">): string {
	const lines = ["---"];
	lines.push(`id: ${meta.id}`);
	lines.push(`type: ${meta.type}`);
	lines.push(`status: ${meta.status}`);
	lines.push(`producer: ${meta.producer}`);
	lines.push(`consumer: ${meta.consumer}`);
	lines.push(`version: ${meta.version}`);
	if (meta.supersedes) lines.push(`supersedes: ${meta.supersedes}`);
	lines.push(`created: ${meta.created}`);
	lines.push(`updated: ${meta.updated}`);
	lines.push("---");
	return lines.join("\n");
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("\n---", 4);
	if (end === -1) return { meta: {}, body: content };
	const fmText = content.slice(4, end);
	const body = content.slice(end + 4).replace(/^\n/, "");
	const meta: Record<string, string> = {};
	for (const line of fmText.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return { meta, body };
}

function extractTitle(body: string, fallback: string): string {
	const m = /^#\s+(.+)$/m.exec(body);
	return m ? m[1].trim() : fallback;
}

// ── Read a single contract ───────────────────────────────────────────────

export function readContractMeta(dir: string, id: string): ContractMeta | null {
	const filePath = path.join(dir, `${id}.md`);
	try {
		const stat = fs.statSync(filePath);
		const content = fs.readFileSync(filePath, "utf-8");
		const { meta, body } = parseFrontmatter(content);
		return {
			id,
			type: (meta.type as ContractType) ?? "other",
			status: (meta.status as ContractStatus) ?? "draft",
			producer: meta.producer ?? "",
			consumer: meta.consumer ?? "",
			version: parseInt(meta.version ?? "1", 10),
			supersedes: meta.supersedes,
			created: meta.created ?? stat.birthtime.toISOString(),
			updated: meta.updated ?? stat.mtime.toISOString(),
			sizeBytes: stat.size,
			title: extractTitle(body, id),
		};
	} catch {
		return null;
	}
}

export function listAllContracts(cwd: string): ContractMeta[] {
	const dir = contractsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => readContractMeta(dir, f.slice(0, -3)))
		.filter((m): m is ContractMeta => m !== null)
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

// ── Result type ──────────────────────────────────────────────────────────

export type ContractResult =
	| { ok: true; message: string; id?: string; content?: string; contracts?: ContractMeta[] }
	| { ok: false; error: string };

// ── Actions ──────────────────────────────────────────────────────────────

export function contractCreate(
	cwd: string,
	params: {
		name: string;
		type: ContractType;
		producer: string;
		consumer: string;
		content: string;
	},
): ContractResult {
	const { name, type, producer, consumer, content } = params;
	if (!name.trim()) return { ok: false, error: "name is required." };
	if (!content.trim()) return { ok: false, error: "content is required." };
	if (!producer.trim()) return { ok: false, error: "producer is required." };
	if (!consumer.trim()) return { ok: false, error: "consumer is required." };

	const dir = ensureContractsDir(cwd);
	const id = uniqueContractId(cwd, name);
	const now = new Date().toISOString();

	const fm = serializeFrontmatter({ id, type, status: "draft", producer, consumer, version: 1, created: now, updated: now });
	const body = content.startsWith("# ") ? content : `# ${name}\n\n${content}`;
	fs.writeFileSync(path.join(dir, `${id}.md`), `${fm}\n\n${body}`, "utf-8");

	return { ok: true, message: `Contract created as draft: ${id}.md`, id };
}

export function contractGet(cwd: string, id: string): ContractResult {
	const filePath = path.join(contractsDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Contract "${id}" not found.` };
	const content = fs.readFileSync(filePath, "utf-8");
	return { ok: true, message: `Contract "${id}"`, id, content };
}

export function contractList(cwd: string): ContractResult {
	const contracts = listAllContracts(cwd);
	return { ok: true, message: `${contracts.length} contract(s).`, contracts };
}

export function contractEdit(
	cwd: string,
	id: string,
	oldText: string,
	newText: string,
): ContractResult {
	const dir = contractsDir(cwd);
	const filePath = path.join(dir, `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Contract "${id}" not found.` };

	const content = fs.readFileSync(filePath, "utf-8");
	const { meta } = parseFrontmatter(content);
	if (meta.status !== "draft") {
		return { ok: false, error: `Contract "${id}" has status "${meta.status}" and cannot be edited. Only draft contracts can be edited. Use supersede to create a new version.` };
	}

	const occurrences = content.split(oldText).length - 1;
	if (occurrences === 0) return { ok: false, error: `oldText not found in contract "${id}". Check exact whitespace and content.` };
	if (occurrences > 1) return { ok: false, error: `oldText matches ${occurrences} locations in contract "${id}". Provide more context to make it unique.` };

	const now = new Date().toISOString();
	const updated = content.replace(oldText, newText).replace(
		/^updated: .+$/m,
		`updated: ${now}`,
	);
	fs.writeFileSync(filePath, updated, "utf-8");
	return { ok: true, message: `Contract "${id}" updated.`, id };
}

export function contractPropose(cwd: string, id: string): ContractResult {
	const dir = contractsDir(cwd);
	const filePath = path.join(dir, `${id}.md`);
	if (!fs.existsSync(filePath)) return { ok: false, error: `Contract "${id}" not found.` };

	const content = fs.readFileSync(filePath, "utf-8");
	const { meta } = parseFrontmatter(content);
	if (meta.status !== "draft") {
		return { ok: false, error: `Contract "${id}" is already "${meta.status}". Only draft contracts can be proposed.` };
	}

	const now = new Date().toISOString();
	const updated = content
		.replace(/^status: .+$/m, "status: proposed")
		.replace(/^updated: .+$/m, `updated: ${now}`);
	fs.writeFileSync(filePath, updated, "utf-8");
	return { ok: true, message: `Contract "${id}" is now proposed.`, id };
}

export function contractSupersede(
	cwd: string,
	oldId: string,
	params: {
		name: string;
		content: string;
	},
): ContractResult {
	const dir = ensureContractsDir(cwd);
	const oldFilePath = path.join(dir, `${oldId}.md`);
	if (!fs.existsSync(oldFilePath)) return { ok: false, error: `Contract "${oldId}" not found.` };

	const oldContent = fs.readFileSync(oldFilePath, "utf-8");
	const { meta: oldMeta } = parseFrontmatter(oldContent);
	const oldVersion = parseInt(oldMeta.version ?? "1", 10);

	// Mark old contract as superseded
	const now = new Date().toISOString();
	const oldUpdated = oldContent
		.replace(/^status: .+$/m, "status: superseded")
		.replace(/^updated: .+$/m, `updated: ${now}`);
	fs.writeFileSync(oldFilePath, oldUpdated, "utf-8");

	// Create new contract
	const newId = uniqueContractId(cwd, params.name);
	const fm = serializeFrontmatter({
		id: newId,
		type: (oldMeta.type as ContractType) ?? "other",
		status: "draft",
		producer: oldMeta.producer ?? "",
		consumer: oldMeta.consumer ?? "",
		version: oldVersion + 1,
		supersedes: oldId,
		created: now,
		updated: now,
	});
	const body = params.content.startsWith("# ") ? params.content : `# ${params.name}\n\n${params.content}`;
	fs.writeFileSync(path.join(dir, `${newId}.md`), `${fm}\n\n${body}`, "utf-8");

	return { ok: true, message: `Contract "${oldId}" superseded. New contract: ${newId}.md (v${oldVersion + 1})`, id: newId };
}
