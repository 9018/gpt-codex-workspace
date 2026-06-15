/**
 * Bark push notification module for GPTWork.
 *
 * Config sources (in priority order):
 *   1. Explicit config object passed to createBarkNotifier()
 *   2. process.env (set from runtime env or system env)
 *
 * Supported env vars:
 *   GPTWORK_BARK_ENABLED  - "true"/"false" (default true if url or key present)
 *   GPTWORK_BARK_URL      - Full Bark API endpoint URL
 *   GPTWORK_BARK_KEY      - Bark API key (alternative to full URL)
 *   GPTWORK_BARK_GROUP    - Default notification group
 *   GPTWORK_BARK_SOUND    - Notification sound
 *   GPTWORK_BARK_LEVEL    - Notification level (active/timeSensitive/passive)
 *
 * The endpoint value is never stored, logged, or exposed in status output.
 */

const DEFAULT_BARK_BASE = "https://api.day.app";
const DEFAULT_GROUP = "gptwork";

/**
 * Build a Bark configuration from explicit options and process.env.
 * process.env values take lowest priority (runtime env loader already
 * filled missing values into process.env before this module is called).
 */
function buildConfig(options = {}) {
  const rawEnabled = options.barkEnabled ?? process.env.GPTWORK_BARK_ENABLED;
  const rawUrl = options.barkUrl ?? process.env.GPTWORK_BARK_URL;
  const rawKey = options.barkKey ?? process.env.GPTWORK_BARK_KEY;
  const rawGroup = options.barkGroup ?? process.env.GPTWORK_BARK_GROUP;
  const rawSound = options.barkSound ?? process.env.GPTWORK_BARK_SOUND;
  const rawLevel = options.barkLevel ?? process.env.GPTWORK_BARK_LEVEL;

  const hasUrl = Boolean(rawUrl);
  const hasKey = Boolean(rawKey);

  // enabled=false always disables
  let enabled;
  if (rawEnabled === "false" || rawEnabled === false) {
    enabled = false;
  } else {
    // If explicitly set true, respect it; otherwise auto-enable if endpoint present
    enabled = rawEnabled === "true" || rawEnabled === true || hasUrl || hasKey;
  }

  return {
    enabled,
    url: rawUrl || "",
    key: rawKey || "",
    group: rawGroup || DEFAULT_GROUP,
    sound: rawSound || "",
    level: rawLevel || "",
    hasUrl,
    hasKey
  };
}

/**
 * Create a Bark notifier instance.
 *
 * @param {object}   options
 * @param {boolean|string} [options.barkEnabled]
 * @param {string}   [options.barkUrl]
 * @param {string}   [options.barkKey]
 * @param {string}   [options.barkGroup]
 * @param {string}   [options.barkSound]
 * @param {string}   [options.barkLevel]
 * @returns {object}
 */
export function createBarkNotifier(options = {}) {
  const cfg = buildConfig(options);

  /** Return whether Bark is fully enabled and ready to send. */
  function isEnabled() {
    return cfg.enabled && (cfg.hasUrl || cfg.hasKey);
  }

  /**
   * Determine the final endpoint URL for a Bark notification.
   * Does NOT expose the key or URL in logs or returned data.
   */
  function buildUrl(title, body, group, sound, level) {
    if (cfg.hasUrl) {
      // Full URL mode: append /title/body to the configured endpoint
      let base = cfg.url.replace(/\/+$/, "");
      // If the URL already looks like a Bark push path (has /<key>/), use as-is
      // Otherwise append encoded title/body
      const encodedTitle = encodeURIComponent(String(title));
      const encodedBody = encodeURIComponent(String(body));
      base += `/${encodedTitle}/${encodedBody}`;
      const params = new URLSearchParams();
      if (group) params.set("group", group);
      if (sound) params.set("sound", sound);
      if (level) params.set("level", level);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }

    // Key-based mode: https://api.day.app/<key>/<title>/<body>
    const encodedKey = encodeURIComponent(cfg.key);
    const encodedTitle = encodeURIComponent(String(title));
    const encodedBody = encodeURIComponent(String(body));
    let url = `${DEFAULT_BARK_BASE}/${encodedKey}/${encodedTitle}/${encodedBody}`;
    const params = new URLSearchParams();
    if (group) params.set("group", group);
    if (sound) params.set("sound", sound);
    if (level) params.set("level", level);
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    return url;
  }

  /**
   * Send a Bark notification.
   *
   * @param {string} title
   * @param {string} [body=""]
   * @param {string} [group]      Override default group
   * @param {object} [opts]       Additional options { sound, level }
   * @returns {Promise<{ok: boolean, reason?: string, error?: string, bark_id?: string}>}
   */
  async function send(title, body = "", group, opts = {}) {
    if (!cfg.hasUrl && !cfg.hasKey) {
      return { ok: false, reason: "bark not configured" };
    }
    if (!cfg.enabled) {
      return { ok: false, reason: "bark disabled" };
    }

    const usedGroup = group || cfg.group;
    const usedSound = opts.sound || cfg.sound;
    const usedLevel = opts.level || cfg.level;

    const url = buildUrl(title, body, usedGroup, usedSound, usedLevel);

    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === 200) {
        return { ok: true, bark_id: data.message || "ok" };
      }
      return { ok: false, error: data.message || "unknown bark error" };
    } catch (err) {
      return { ok: false, error: "notification failed" };
    }
  }

  /**
   * Send a test notification (returns ok/error only, no endpoint exposure).
   */
  async function testSend() {
    if (!cfg.hasUrl && !cfg.hasKey) {
      return { ok: false, error: "bark not configured" };
    }
    if (!cfg.enabled) {
      return { ok: false, error: "bark disabled" };
    }
    return send("GPTWork Test", "If you receive this message, Bark notification is configured correctly.", "gptwork-test");
  }

  /**
   * Return safe status info (no real endpoint/key values exposed).
   */
  function getStatus() {
    return {
      enabled: cfg.enabled,
      configured: cfg.hasUrl || cfg.hasKey,
      url_set: cfg.hasUrl,
      key_set: cfg.hasKey,
      group: cfg.group,
      sound_set: Boolean(cfg.sound),
      level_set: Boolean(cfg.level)
    };
  }

  return { isEnabled, send, testSend, getStatus };
}
