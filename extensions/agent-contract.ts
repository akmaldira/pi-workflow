/**
 * Agent contract — compatibility contract for subagent execution.
 */

export function isAgentContractV1(contract?: { version: 1 }): boolean {
	return contract?.version === 1;
}

export function attachContractProjections(result: any, contract?: { version: 1 }): void {
	// No-op in this simplified version
}
