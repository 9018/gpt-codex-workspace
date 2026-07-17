export const EXECUTION_PROVIDER_METHODS = Object.freeze([
  "start",
  "observe",
  "send",
  "interrupt",
  "resume",
  "collect",
  "dispose",
]);

const PROVIDERS = new Set(["codex_exec", "codex_tui"]);

export function assertExecutionProviderContract(provider) {
  if (!provider || typeof provider !== "object") throw new Error("execution provider must be an object");
  if (!PROVIDERS.has(provider.name)) throw new Error(`unsupported execution provider: ${provider.name}`);
  for (const method of EXECUTION_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(`execution provider ${provider.name} missing required method ${method}`);
    }
  }
  return true;
}
