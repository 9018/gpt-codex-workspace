/**
 * execution-provider-registry.mjs — Provider registry with normalization wrappers.
 *
 * @deprecated Wave 10R — 共享基础设施，保留。新代码应通过 pipeline adapter 间接使用。
 *
 * Every provider method call is wrapped with the corresponding normalizer
 * from execution-provider-contract.mjs so that callers never see raw
 * provider output that violates the contract.
 *
 * Normalization applied:
 *   start   -> normalizeProviderSession   (session shape)
 *   resume  -> normalizeProviderSession   (session shape)
 *   observe -> normalizeProviderObservation (state + fail-closed)
 *   collect -> passthrough (result shape varies by provider)
 *
 * @module execution-provider-registry
 */

import {
  assertExecutionProviderContract,
  normalizeProviderSession,
  normalizeProviderObservation,
} from "./execution-provider-contract.mjs";

/**
 * Create the execution provider registry.
 *
 * @returns {object} Registry API
 */
export function createExecutionProviderRegistry() {
  const providers = new Map();

  /**
   * Wrap a provider's methods with normalization.
   */
  function wrapProvider(provider) {
    const wrapped = { ...provider };

    // start: normalize session output
    const originalStart = provider.start;
    wrapped.start = async function wrappedStart(...args) {
      const result = await originalStart.apply(provider, args);
      return normalizeProviderSession(result);
    };

    // resume: normalize session output
    const originalResume = provider.resume;
    wrapped.resume = async function wrappedResume(...args) {
      const result = await originalResume.apply(provider, args);
      return normalizeProviderSession(result);
    };

    // observe: normalize observation state (fail closed on unknown states)
    const originalObserve = provider.observe;
    wrapped.observe = async function wrappedObserve(...args) {
      const result = await originalObserve.apply(provider, args);
      return normalizeProviderObservation(result);
    };

    // collect: passthrough (result shape varies by provider and
    // contains execution results like status/summary/tests that
    // should not be normalized into raw evidence here)
    const originalCollect = provider.collect;
    wrapped.collect = async function wrappedCollect(...args) {
      return originalCollect.apply(provider, args);
    };

    return wrapped;
  }

  return {
    /**
     * Register a provider.  The provider is validated and wrapped with
     * normalization for start, resume, observe, and collect.
     *
     * @param {object} provider - Provider object satisfying the contract
     * @returns {object} The original provider (for chaining)
     */
    register(provider) {
      assertExecutionProviderContract(provider);
      if (providers.has(provider.name)) {
        throw new Error(`execution provider already registered: ${provider.name}`);
      }
      providers.set(provider.name, { original: provider, wrapped: wrapProvider(provider) });
      return provider;
    },

    /**
     * Get a provider with normalization wrappers applied.
     *
     * @param {string} name - Provider name
     * @returns {object|null} Wrapped provider, or null if not registered
     */
    get(name) {
      const entry = providers.get(name);
      return entry ? entry.wrapped : null;
    },

    /**
     * Get the original unwrapped provider.
     *
     * @param {string} name - Provider name
     * @returns {object|null} Original provider, or null if not registered
     */
    unwrap(name) {
      const entry = providers.get(name);
      return entry ? entry.original : null;
    },

    /**
     * Check if a provider is available.
     *
     * @param {string} name - Provider name
     * @param {object} [context={}] - Availability context
     * @returns {Promise<boolean>}
     */
    async isAvailable(name, context = {}) {
      const entry = providers.get(name);
      if (!entry) return false;
      const fn = entry.original.availability;
      return typeof fn === "function" ? Boolean(await fn(context)) : true;
    },

    /**
     * Get availability of all registered providers.
     *
     * @param {object} [context={}] - Availability context
     * @returns {Promise<object>} Map of provider name -> boolean
     */
    async availability(context = {}) {
      return Object.fromEntries(await Promise.all(
        [...providers.keys()].map(async (name) => [name, await this.isAvailable(name, context)]),
      ));
    },

    /**
     * Describe all registered providers.
     *
     * @returns {object[]} Array of { name, revision }
     */
    describe() {
      return [...providers.values()]
        .map((entry) => ({ name: entry.original.name, revision: entry.original.revision || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
