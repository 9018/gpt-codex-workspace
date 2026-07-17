import { assertExecutionProviderContract } from "./execution-provider-contract.mjs";

export function createExecutionProviderRegistry() {
  const providers = new Map();
  return {
    register(provider) {
      assertExecutionProviderContract(provider);
      if (providers.has(provider.name)) throw new Error(`execution provider already registered: ${provider.name}`);
      providers.set(provider.name, provider);
      return provider;
    },
    get(name) { return providers.get(name) || null; },
    async isAvailable(name, context = {}) {
      const provider = providers.get(name);
      if (!provider) return false;
      return typeof provider.available === "function" ? Boolean(await provider.available(context)) : true;
    },
    async availability(context = {}) {
      return Object.fromEntries(await Promise.all(
        [...providers.keys()].map(async (name) => [name, await this.isAvailable(name, context)]),
      ));
    },
    describe() {
      return [...providers.values()]
        .map((provider) => ({ name: provider.name, revision: provider.revision || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
