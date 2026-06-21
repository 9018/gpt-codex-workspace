export function createHookBus() {
  const handlers = new Map();
  return {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {
        const list = handlers.get(name) || [];
        handlers.set(name, list.filter((candidate) => candidate !== handler));
      };
    },
    async emit(name, event) {
      const results = [];
      for (const handler of handlers.get(name) || []) {
        try {
          results.push({ ok: true, result: await handler(event) });
        } catch (error) {
          results.push({ ok: false, error: error.message });
        }
      }
      return { hook: name, handlers: results.length, results };
    },
  };
}
