/**
 * execution-provider-interface.mjs — Provider interface contract
 * and registry for execution providers.
 *
 * Every execution provider (codex_exec, codex_tui) must implement the
 * ExecutionProvider interface defined by the methods below.
 *
 * @module execution-provider-interface
 */

import { EXECUTION_PROVIDERS } from "./execution-contract.mjs";

/** Required method names for an ExecutionProvider */
const REQUIRED_METHODS = ["start", "status", "stop", "cancel", "collect", "readLogs"];

/**
 * Assert that a provider object satisfies the ExecutionProvider interface.
 *
 * @param {object} provider - Provider object to validate
 * @param {string} provider.name - Provider name
 * @throws {Error} If provider doesn't satisfy the interface
 */
export function assertExecutionProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error(`Execution provider must be an object, got ${typeof provider}`);
  }

  if (!provider.name || !EXECUTION_PROVIDERS.includes(provider.name)) {
    throw new Error(
      `Provider name must be one of [${EXECUTION_PROVIDERS.join(", ")}], got "${provider?.name}"`,
    );
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(
        `Execution provider "${provider.name}" missing required method "${method}"`,
      );
    }
  }
}

/**
 * Create a provider registry.
 *
 * @returns {object} { register, get, getAll, hasProvider }
 */
export function createProviderRegistry() {
  const providers = new Map();

  return {
    /**
     * Register a provider.
     * @param {object} provider - Provider implementing ExecutionProvider interface
     */
    register(provider) {
      assertExecutionProvider(provider);
      if (providers.has(provider.name)) {
        throw new Error(`Provider "${provider.name}" is already registered`);
      }
      providers.set(provider.name, provider);
    },

    /**
     * Get a provider by name.
     * @param {string} name - Provider name
     * @returns {object|null} Provider or null if not found
     */
    get(name) {
      return providers.get(name) || null;
    },

    /**
     * Get all registered providers.
     * @returns {Array<{name: string, provider: object}>}
     */
    getAll() {
      return Array.from(providers.entries()).map(([name, provider]) => ({
        name,
        provider,
      }));
    },

    /**
     * Check if a provider is registered.
     * @param {string} name - Provider name
     * @returns {boolean}
     */
    hasProvider(name) {
      return providers.has(name);
    },
  };
}
