export const DEFAULT_BARK_BASE = "https://api.day.app";
export const DEFAULT_GROUP = "gptwork";

// Chinese status labels for notification body.
// Maps internal status strings to user-facing Chinese text.
export const STATUS_ZH = {
  created: "已创建",
  assigned: "已分配",
  queued: "已排队",
  running: "运行中",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
  timed_out: "已超时",
  codex_timeout: "已超时",
  waiting_for_review: "等待审核",
  waiting_review: "等待审核",
  waiting_for_lock: "等待锁",
  waiting_for_repair: "等待修复",
  blocked: "已阻塞",
  draft: "草稿",
  paused: "已暂停",
  repair: "修复中",
};

// Chinese event labels for lifecycle notification title.
export const EVENT_ZH = {
  task_created: "新任务已创建",
  task_started: "任务已启动",
  task_running: "任务运行中",
  task_completed: "任务已完成",
  task_failed: "任务已失败",
  task_blocked: "任务已阻塞",
  task_timeout: "任务已超时",
  task_cancelled: "任务已取消",
  task_waiting_for_review: "任务等待审核",
  task_waiting_for_repair: "任务等待修复",
  repair_created: "修复任务已创建",
  repair_started: "修复已启动",
  repair_completed: "修复已完成",
  repair_failed: "修复已失败",
  github_imported: "已从 GitHub 导入",
  github_synced: "已同步 GitHub",
  github_sync_failed: "GitHub 同步失败",
  restart_required: "需要重启",
  restart_completed: "重启已完成",
};

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
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSecs = seconds % 60;
  if (minutes < 60) return remainSecs ? `${minutes}分${remainSecs}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins ? `${hours}小时${remainMins}分` : `${hours}小时`;
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
