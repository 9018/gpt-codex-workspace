export function normalizeIntegrationFacts(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return Object.freeze({
    required: source.required === true,
    satisfied: source.satisfied === true,
    terminal: source.terminal === true,
    status: source.status || null,
    evidence: Array.isArray(source.evidence) ? [...source.evidence] : [],
  });
}

export function integrationAllowsCompletion(raw = {}) {
  const facts = normalizeIntegrationFacts(raw);
  return !facts.required || (facts.satisfied && facts.terminal);
}
