// Example workflow: Security audit
// This workflow uses the scout and researcher agents to perform a security audit

const findings = await agent('scout: Find security issues in the codebase, focusing on authentication, input validation, and data handling');

if (findings.critical) {
  await agent('researcher: Investigate the critical security findings and provide detailed remediation steps');
}

return {
  status: 'complete',
  findings: findings,
};
