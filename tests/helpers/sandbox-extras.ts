/**
 * Test helpers: sandbox factory functions for plan and contract,
 * mirroring what graph-tool.ts injects into the real script sandbox.
 * Used by graph-sandbox-extras.test.ts.
 */

import {
	planCreate, planGet, planList, planEdit, planDelete,
} from "../../extensions/plan-tool.ts";
import {
	contractCreate, contractGet, contractList, contractEdit,
	contractPropose, contractSupersede,
} from "../../extensions/contract-tool.ts";

export function makePlanSandboxForTest(cwd: string) {
	return {
		create: (name: string, content: string) => planCreate(cwd, name, content),
		get:    (id: string) => planGet(cwd, id),
		list:   () => planList(cwd),
		edit:   (id: string, oldText: string, newText: string) => planEdit(cwd, id, oldText, newText),
		delete: (id: string) => planDelete(cwd, id),
	};
}

export function makeContractSandboxForTest(cwd: string) {
	return {
		create:    (params: Parameters<typeof contractCreate>[1]) => contractCreate(cwd, params),
		get:       (id: string) => contractGet(cwd, id),
		list:      () => contractList(cwd),
		edit:      (id: string, oldText: string, newText: string) => contractEdit(cwd, id, oldText, newText),
		propose:   (id: string) => contractPropose(cwd, id),
		supersede: (oldId: string, params: Parameters<typeof contractSupersede>[2]) => contractSupersede(cwd, oldId, params),
	};
}
