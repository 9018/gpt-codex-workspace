export const DEFAULT_BARK_BASE = "https://api.day.app";
export const DEFAULT_GROUP = "gptwork";

// Status emoji mapping for title fallback when no icon is configured.
export const STATUS_EMOJI = {
  completed: "\u2705",
  failed: "\u274C",
  timed_out: "\u23F1\uFE0F",
  waiting_review: "\uD83D\uDC40",
  waiting_for_review: "\uD83D\uDC40",
  codex_timeout: "\u23F1\uFE0F",
  manual_test: "\uD83E\uDDEA",
  created: "\uD83C\uDD95"
};

/**
 * Format milliseconds to a human-readable duration string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSecs = seconds % 60;
  if (minutes < 60) return remainSecs ? `${minutes}m${remainSecs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins ? `${hours}h${remainMins}m` : `${hours}h`;
}

/**
 * Build a Bark configuration from explicit options and process.env.
 * process.env values take lowest priority (runtime env loader already
 * filled missing values into process.env before this module is called).
 *
 * Returns a config object with a `_sources` map tracking which source
 * provided each value (options, process.env, or not-set) so the notifier
 * can report a safe config source without exposing actual values.
 */
export function buildConfig(options = {}) {
  const rawEnabled = options.barkEnabled ?? process.env.GPTWORK_BARK_ENABLED;
  // Force-disable in test/non-notification modes.
  // npm test, node --test, CI, NODE_ENV=test, GPTWORK_TEST_MODE=true, or
  // GPTWORK_DISABLE_NOTIFICATIONS=true always disable the notifier so that
  // test environments never send real Bark HTTP requests.
  const isTestMode = process.env.NODE_ENV === 'test' ||
    process.env.GPTWORK_TEST_MODE === 'true' ||
    process.env.GPTWORK_DISABLE_NOTIFICATIONS === 'true';
  const rawUrl = options.barkUrl ?? process.env.GPTWORK_BARK_URL;
  const rawKey = options.barkKey ?? process.env.GPTWORK_BARK_KEY;
  const rawGroup = options.barkGroup ?? process.env.GPTWORK_BARK_GROUP;
  const rawSound = options.barkSound ?? process.env.GPTWORK_BARK_SOUND;
  const rawLevel = options.barkLevel ?? process.env.GPTWORK_BARK_LEVEL;
  const rawIconUrl = options.barkIconUrl ?? process.env.GPTWORK_BARK_ICON_URL ?? process.env.GPTWORK_BARK_ICON;
  const rawClickUrl = options.barkClickUrl ?? process.env.GPTWORK_BARK_CLICK_URL ?? process.env.GPTWORK_BARK_ACTION_URL;
  const rawBadge = options.barkBadge ?? process.env.GPTWORK_BARK_BADGE;

  const hasUrl = Boolean(rawUrl);
  const hasKey = Boolean(rawKey);
  const hasIcon = Boolean(rawIconUrl);
  const hasClickUrl = Boolean(rawClickUrl);
  const hasBadge = rawBadge !== undefined && rawBadge !== null && rawBadge !== "";

  // Track source for each value (used internally for source reporting)
  const _sources = {};
  const _entries = [
    ["barkEnabled", "GPTWORK_BARK_ENABLED"],
    ["barkUrl", "GPTWORK_BARK_URL"],
    ["barkKey", "GPTWORK_BARK_KEY"],
    ["barkGroup", "GPTWORK_BARK_GROUP"],
    ["barkSound", "GPTWORK_BARK_SOUND"],
    ["barkLevel", "GPTWORK_BARK_LEVEL"],
    ["barkIconUrl", "GPTWORK_BARK_ICON_URL"],
    ["barkClickUrl", "GPTWORK_BARK_CLICK_URL"],
    ["barkBadge", "GPTWORK_BARK_BADGE"]
  ];
  for (const [optKey, envKey] of _entries) {
    if (options[optKey] !== undefined) _sources[optKey] = "options";
    else if (process.env[envKey] !== undefined) _sources[optKey] = "process.env";
    else _sources[optKey] = "not-set";
  }

  // enabled=false always disables
  let enabled;
  if (rawEnabled === "false" || rawEnabled === false) {
    enabled = false;
  } else {
    enabled = rawEnabled === "true" || rawEnabled === true || hasUrl || hasKey;
  // Force disabled in test mode regardless of configuration (overrides everything).
  // This ensures no real Bark HTTP request is made during tests.
  if (isTestMode) enabled = false;
  }

  return {
    enabled,
    url: rawUrl || "",
    key: rawKey || "",
    group: rawGroup || DEFAULT_GROUP,
    sound: rawSound || "",
    level: rawLevel || "",
    iconUrl: rawIconUrl || "",
    clickUrl: rawClickUrl || "",
    badge: hasBadge ? rawBadge : null,
    hasUrl,
    hasKey,
    hasIcon,
    hasClickUrl,
    _sources
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
 * @param {string}   [options.barkIconUrl]
 * @param {string}   [options.barkClickUrl]
 * @param {number|string} [options.barkBadge]
 * @param {string}   [configSource]  Safe source label
 * @returns {object}
 */
