const BARK_BASE = "https://api.day.app";

export function createBarkNotifier(config = {}) {
  const key = config.barkKey || process.env.GPTWORK_BARK_KEY || "";
  const enabled = !!key;

  return {
    isEnabled() { return enabled; },

    async send(title, body = "", group = "gptwork") {
      if (!enabled) return { ok: false, reason: "bark not configured" };
      const encodedTitle = encodeURIComponent(String(title));
      const encodedBody = encodeURIComponent(String(body));
      let url = `${BARK_BASE}/${encodeURIComponent(key)}/${encodedTitle}/${encodedBody}`;
      if (group) url += `?group=${encodeURIComponent(group)}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.code === 200) {
          return { ok: true, bark_id: data.message || null };
        }
        return { ok: false, error: data.message || "unknown error" };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async testSend() {
      return this.send("GPTWork Test", "如果收到这条消息，Bark 通知配置正确", "gptwork-test");
    }
  };
}
