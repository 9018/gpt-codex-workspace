/**
 * prompt-templates.mjs — Acceptance prompt templates for GPTChat.
 *
 * These templates frame acceptance requests so that a human reviewer or
 * GPTChat can understand what was done, what artifacts to inspect, and
 * what criteria to check.
 *
 * Each template produces a structured prompt that references files from
 * the acceptance bundle zip.
 */

/**
 * Build the acceptance review prompt for GPTChat.
 *
 * @param {object} options
 * @param {object} options.bundle - Task acceptance bundle (from task-acceptance-bundle.mjs)
 * @param {string} [options.acceptanceCriteria] - Custom acceptance criteria text
 * @param {object} [options.contract] - Acceptance contract (overrides bundle contract summary)
 * @param {string} [options.bundleRef] - Reference to the bundle zip (e.g. file path or URL)
 * @returns {string} The formatted prompt
 */
export function buildAcceptancePrompt({ bundle, acceptanceCriteria, contract, bundleRef } = {}) {
  const title = bundle?.title || bundle?.task_id || 'Task';
  const taskId = bundle?.task_id || 'unknown';
  const goalId = bundle?.goal_id || 'unknown';
  const status = bundle?.status || 'unknown';
  const operationKind = bundle?.operation_kind || bundle?.acceptance_contract_summary?.operation_kind || 'unknown';
  const contractSummary = bundle?.acceptance_contract_summary;

  const lines = [
    `# Acceptance Review: ${title}`,
    '',
    `Please review the task results in the attached acceptance bundle and determine whether to **accept**, **reject**, or **request changes**.`,
    '',
    '---',
    '',
    '## Task Overview',
    '',
    `- **Task ID**: ${taskId}`,
    `- **Goal ID**: ${goalId}`,
    `- **Status**: ${status}`,
    `- **Operation Kind**: ${operationKind}`,
    '',
    '### Result Summary',
    bundle?.result_summary?.summary
      ? `> ${bundle.result_summary.summary}`
      : '(no result summary available)',
    '',
  ];

  // Acceptance criteria from contract
  if (contract?.acceptance_criteria?.length || contractSummary?.blocking_requirements?.length) {
    lines.push('## Acceptance Criteria', '');
    const criteria = contract?.acceptance_criteria || [];
    const blockingReqs = contractSummary?.blocking_requirements || [];
    for (const req of blockingReqs) {
      lines.push(`- [ ] **${req.id}**: ${req.description}`);
    }
    for (const c of criteria) {
      lines.push(`- [ ] ${c}`);
    }
    lines.push('');
  }

  // Changed files
  if (bundle?.changed_files?.length) {
    lines.push('## Changed Files', '');
    for (const file of bundle.changed_files) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  // Verification results
  if (bundle?.verification) {
    lines.push('## Verification Results', '');
    lines.push(`- **Passed**: ${bundle.verification.passed}`);
    lines.push(`- **Status**: ${bundle.verification.status}`);
    if (bundle.verification.commands?.length) {
      lines.push('', '### Commands', '');
      for (const cmd of bundle.verification.commands) {
        const cmdStr = cmd.cmd || cmd.command || '(unknown)';
        const exitCode = cmd.exit_code;
        const passed = cmd.passed;
        lines.push(`- \`${cmdStr}\` → exit=${exitCode} passed=${passed}`);
      }
    }
    if (bundle.verification.findings?.length) {
      lines.push('', '### Findings', '');
      for (const finding of bundle.verification.findings) {
        lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}`);
      }
    }
    lines.push('');
  }

  // Contract verification results
  if (bundle?.contract_verification) {
    lines.push('## Contract Verification', '');
    lines.push(`- **Contract Valid**: ${bundle.contract_verification.contract_valid}`);
    lines.push(`- **Blocking Passed**: ${bundle.contract_verification.blocking_passed}`);
    lines.push(`- **Acceptance Status**: ${bundle.contract_verification.acceptance_status}`);
    if (bundle.contract_verification.blockers?.length) {
      lines.push('', '### Blockers', '');
      for (const blocker of bundle.contract_verification.blockers) {
        lines.push(`- [${blocker.severity}] ${blocker.code}: ${blocker.message}`);
      }
    }
    lines.push('');
  }

  // Existing blockers from acceptance agent
  if (bundle?.blockers?.length) {
    lines.push('## Existing Blockers', '');
    for (const blocker of bundle.blockers) {
      lines.push(`- [${blocker.severity}] ${blocker.code}: ${blocker.message}`);
    }
    lines.push('');
  }

  // Follow-ups
  if (bundle?.non_blocking_followups?.length) {
    lines.push('## Non-blocking Follow-ups', '');
    for (const item of bundle.non_blocking_followups) {
      lines.push(`- ${item.message || item.code || JSON.stringify(item)}`);
    }
    lines.push('');
  }

  // Missing evidence
  if (bundle?.missing_evidence?.length) {
    lines.push('## Missing Evidence', '');
    for (const item of bundle.missing_evidence) {
      lines.push(`- **${item.code}**: ${item.message}`);
    }
    lines.push('');
  }

  // Bundle reference
  if (bundleRef) {
    lines.push('## Bundle Reference', '');
    lines.push(`The acceptance bundle is available at: \`${bundleRef}\``);
    lines.push('');
  }

  // Review decision section
  lines.push('---', '', '## Your Decision', '');
  lines.push('Please respond with one of the following decisions:');
  lines.push('');
  lines.push('### ✅ Accept');
  lines.push('- The task satisfies all acceptance criteria.');
  lines.push('- No critical issues found.');
  lines.push('');
  lines.push('### ❌ Reject (with findings)');
  lines.push('- Blocking issues remain that prevent acceptance.');
  lines.push('- Provide specific findings that must be fixed.');
  lines.push('');
  lines.push('### 🔄 Request Changes');
  lines.push('- Non-blocking improvements or clarifications needed.');
  lines.push('- These can be addressed as follow-up tasks.');
  lines.push('');
  lines.push('---', '', '## Response Format', '');
  lines.push([
    '```json',
    '{',
    '  "decision": "accepted|rejected|changes_requested",',
    '  "summary": "Brief human-readable summary of your decision",',
    '  "findings": [',
    '    {',
    '      "severity": "blocker|major|minor|followup",',
    '      "code": "machine_readable_code",',
    '      "message": "Human-readable description",',
    '      "source": "gptchat_acceptance"',
    '    }',
    '  ],',
    '  "repair_instructions": "If rejected, specific instructions for what to fix",',
    '  "followups": ["Optional follow-up task suggestions"]',
    '}',
    '```',
  ].join('\n'));

  return lines.join('\n');
}

/**
 * Build the "optimization pack" prompt — a brief summary of the task and
 * its context to help GPTChat understand what's being reviewed.
 *
 * @param {object} options
 * @returns {string} Prompt
 */
export function buildOptimizationPrompt({ bundle, goalPrompt, userRequest } = {}) {
  const lines = [
    '# Optimization Review Pack',
    '',
    '## Original Request',
    '',
    userRequest || '(original user request not available)',
    '',
    '## Goal / Instructions',
    '',
    goalPrompt || bundle?.title || '(goal instructions not available)',
    '',
    '## Task Output Summary',
    '',
    bundle?.result_summary?.summary || '(no result summary)',
    '',
    '## Artifacts for Review',
    '',
  ];

  if (bundle?.changed_files?.length) {
    lines.push('### Changed Files');
    for (const file of bundle.changed_files) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  if (bundle?.report_paths) {
    const reportKeys = Object.keys(bundle.report_paths).filter(
      (k) => !k.includes('transcript') && !k.includes('context.bundle')
    );
    if (reportKeys.length > 0) {
      lines.push('### Reports');
      for (const key of reportKeys) {
        lines.push(`- **${key}**: \`${bundle.report_paths[key]}\``);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Build the failure analysis prompt — summarizes what failed and asks
 * GPTChat to determine if this is a real failure or a false positive.
 *
 * @param {object} options
 * @returns {string} Prompt
 */
export function buildFailureAnalysisPrompt({ bundle, verification, contractVerification } = {}) {
  const lines = [
    '# Acceptance Failure Analysis',
    '',
    'A task failed acceptance. Please analyze the failure and determine:',
    '',
    '1. Is this a **real failure** (genuine bug in the implementation)?',
    '2. Is this a **false positive** (acceptance criteria mismatch or test environment issue)?',
    '3. Is this an **acceptance gap** (missing test/evidence that should exist)?',
    '',
    '---',
    '',
    '## Failure Context',
    '',
    `- **Task ID**: ${bundle?.task_id || 'unknown'}`,
    `- **Goal ID**: ${bundle?.goal_id || 'unknown'}`,
    `- **Title**: ${bundle?.title || 'unknown'}`,
    '',
    '## Verification Status',
    '',
    `- **Passed**: ${verification?.passed ?? bundle?.verification?.passed ?? 'unknown'}`,
    `- **Status**: ${verification?.status ?? bundle?.verification?.status ?? 'unknown'}`,
    '',
  ];

  const findings =
    verification?.findings ||
    bundle?.verification?.findings ||
    bundle?.blockers ||
    [];
  if (findings.length > 0) {
    lines.push('### Findings');
    for (const f of findings) {
      lines.push(`- [${f.severity}] ${f.code}: ${f.message}`);
    }
    lines.push('');
  }

  lines.push('---', '', '## Your Analysis', '');
  lines.push([
    '```json',
    '{',
    '  "failure_type": "real|false_positive|acceptance_gap",',
    '  "rationale": "Brief explanation of your analysis",',
    '  "recommended_next_step": "repair|escalate|retry",',
    '  "findings": [',
    '    {...}',
    '  ],',
    '  "repair_hint": "If real failure, specific hint for the repair task"',
    '}',
    '```',
  ].join('\n'));

  return lines.join('\n');
}
