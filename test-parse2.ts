import { parseWorkflowScript } from "./extensions/workflow.ts";

const script = `export const meta = {
  name: 'security_audit',
  description: 'Security audit workflow using scout and researcher agents'
};

phase('Scouting');
const resultText = await agent('scout: Find security issues in the codebase, focusing on authentication, input validation, and data handling. Respond ONLY with valid JSON in this format: { "critical": true/false, "findings": "details..." }', { label: 'find security issues' });

let findings;
try {
  findings = JSON.parse(resultText);
} catch (e) {
  // fallback if agent didn't return pure JSON
  findings = { critical: true, findings: resultText };
}

if (findings.critical) {
  phase('Researching Remediation');
  const remediation = await agent('researcher: Investigate the following critical security findings and provide detailed remediation steps. Findings: ' + JSON.stringify(findings), { label: 'remediation steps' });
  findings.remediation = remediation;
}

return {
  status: 'complete',
  findings: findings,
};`;

try {
	console.log(parseWorkflowScript(script).meta);
} catch (e) {
	console.error(e);
}
