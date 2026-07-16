export function acceptanceAllowsCompletion({ verification = {}, acceptance = {}, review = {} } = {}) {
  const blockingFindings = Array.isArray(review.blocking_findings)
    ? review.blocking_findings
    : [];
  return verification.passed === true
    && acceptance.passed === true
    && blockingFindings.length === 0;
}
