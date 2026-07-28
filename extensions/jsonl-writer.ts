/**
 * Simple JSONL writer for event logging.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface JsonlWriter {
	write(event: object): void;
	flush(): void;
	close(): void;
}

export function createJsonlWriter(filePath: string): JsonlWriter {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	let buffer: string[] = [];
	let closed = false;

	return {
		write(event) {
			if (closed) return;
			buffer.push(JSON.stringify(event));
		},
		flush() {
			if (buffer.length === 0) return;
			fs.appendFileSync(filePath, buffer.join("\n") + "\n", "utf-8");
			buffer = [];
		},
		close() {
			if (closed) return;
			this.flush();
			closed = true;
		},
	};
}
