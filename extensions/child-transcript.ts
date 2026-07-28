/**
 * Child transcript writer — writes structured JSONL transcripts of child
 * subagent execution for debugging and observability.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CHILD_TRANSCRIPT_ARTIFACT_VERSION = 1;
export type ChildTranscriptArtifactVersion = typeof CHILD_TRANSCRIPT_ARTIFACT_VERSION;

export interface ChildTranscriptWriterInput {
	transcriptPath: string;
}

export interface ChildTranscriptWriter {
	append(event: object): void;
	flush(): void;
	close(): void;
}

export function createChildTranscriptWriter(input: ChildTranscriptWriterInput): ChildTranscriptWriter {
	const { transcriptPath } = input;
	fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

	let buffer: string[] = [];
	let closed = false;

	return {
		append(event) {
			if (closed) return;
			buffer.push(JSON.stringify(event));
		},
		flush() {
			if (buffer.length === 0) return;
			fs.appendFileSync(transcriptPath, buffer.join("\n") + "\n", "utf-8");
			buffer = [];
		},
		close() {
			if (closed) return;
			this.flush();
			closed = true;
		},
	};
}
