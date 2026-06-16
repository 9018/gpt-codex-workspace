/**
 * Bark push notification module for GPTWork.
 *
 * Config sources (in priority order):
 *   1. Explicit config object passed to createBarkNotifier()
 *   2. process.env (set from runtime env or system env)
 *
 * Supported env vars:
 *   GPTWORK_BARK_ENABLED      - "true"/"false" (default true if url or key present)
 *   GPTWORK_BARK_URL          - Full Bark API endpoint URL
 *   GPTWORK_BARK_KEY          - Bark API key (alternative to full URL)
 *   GPTWORK_BARK_GROUP        - Default notification group
 *   GPTWORK_BARK_SOUND        - Notification sound
 *   GPTWORK_BARK_LEVEL        - Notification level (active/timeSensitive/passive)
 *   GPTWORK_BARK_ICON_URL     - Default icon URL for all notifications
 *   GPTWORK_BARK_CLICK_URL    - Click/action URL for notifications
 *   GPTWORK_BARK_ACTION_URL   - Alias for click URL
 *   GPTWORK_BARK_BADGE        - Badge count number
 *
 * Notification policy env vars:
 *   GPTWORK_BARK_NOTIFY_TASKS=true         - Global notification toggle
 *   GPTWORK_BARK_NOTIFY_READONLY=false     - Suppress readonly tasks
 *   GPTWORK_BARK_NOTIFY_INTERNAL=false     - Suppress internal tasks
 *   GPTWORK_BARK_NOTIFY_TESTS=false        - Suppress test mode tasks
 *   GPTWORK_BARK_NOTIFY_CANCELLED=false    - Suppress cancelled tasks
 *   GPTWORK_BARK_NOTIFY_WAITING_REVIEW=true - Notify on waiting_for_review
 *   GPTWORK_BARK_NOTIFY_FAILURES=true      - Notify on failures
 *   GPTWORK_BARK_NOTIFY_TIMEOUTS=true      - Notify on timeouts
 *   GPTWORK_BARK_NOTIFY_COMPLETED=true     - Notify on completions
 *
 * The endpoint value is never stored, logged, or exposed in status output.
 */

const DEFAULT_BARK_BASE = "https://api.day.app";
const DEFAULT_GROUP = "gptwork";

// Status emoji mapping for title fallback when no icon is configured.
const STATUS_EMOJI = {
  completed: "\u2705",
  failed: "\u274C",
  timed_out: "\u23F1\uFE0F",
  waiting_review: "\uD83D\uDC40",
  waiting_for_review: "\uD83D\uDC40",
  codex_timeout: "\u23F1\uFE0F",
  manual_test: "\uD83E\uDDEA"
};

/**
 * Format milliseconds to a human-readable duration string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
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
function buildConfig(options = {}) {
  const rawEnabled = options.barkEnabled ?? process.env.GPTWORK_BARK_ENABLED;
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
export function createBarkNotifier(options = {}, configSource = "unknown") {
  const cfg = buildConfig(options);

  // === Diagnostic tracking ===
  const _diag = {
    last_attempt_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_response_code: null,
    last_response_message: null,
    last_error_short: null,
    last_task_id: null,
    last_task_status: null
  };

  function _recordDiag(result, attemptedAt) {
    _diag.last_attempt_at = attemptedAt;
    if (result.ok) {
      _diag.last_success_at = attemptedAt;
      _diag.last_failure_at = _diag.last_failure_at;
      _diag.last_response_code = 200;
      _diag.last_response_message = result.bark_id || "ok";
      _diag.last_error_short = null;
    } else {
      _diag.last_failure_at = attemptedAt;
      _diag.last_success_at = _diag.last_success_at;
      _diag.last_response_code = null;
      _diag.last_response_message = null;
      _diag.last_error_short = result.reason || result.error || "unknown";
    }
  }

  function isEnabled() {
    return cfg.enabled && (cfg.hasUrl || cfg.hasKey);
  }

  /**
   * Build final endpoint URL for a Bark notification.
   * Supports optional query params: group, sound, level, icon, url, badge.
   */
  function buildUrl(title, body, group, sound, level, icon, clickUrl, badge) {
    if (cfg.hasUrl) {
      let base = cfg.url.replace(/\/+$/, "");
      const encodedTitle = encodeURIComponent(String(title));
      const encodedBody = encodeURIComponent(String(body));
      base += `/${encodedTitle}/${encodedBody}`;
      const params = new URLSearchParams();
      if (group) params.set("group", group);
      if (sound) params.set("sound", sound);
      if (level) params.set("level", level);
      if (icon) params.set("icon", icon);
      if (clickUrl) params.set("url", clickUrl);
      if (badge !== undefined && badge !== null && badge !== "") {
        params.set("badge", String(badge));
      }
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }

    const encodedKey = encodeURIComponent(cfg.key);
    const encodedTitle = encodeURIComponent(String(title));
    const encodedBody = encodeURIComponent(String(body));
    let url = `${DEFAULT_BARK_BASE}/${encodedKey}/${encodedTitle}/${encodedBody}`;
    const params = new URLSearchParams();
    if (group) params.set("group", group);
    if (sound) params.set("sound", sound);
    if (level) params.set("level", level);
    if (icon) params.set("icon", icon);
    if (clickUrl) params.set("url", clickUrl);
    if (badge !== undefined && badge !== null && badge !== "") {
      params.set("badge", String(badge));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    return url;
  }

  /**
   * Send a Bark notification.
   *
   * @param {string} title
   * @param {string} [body=""]
   * @param {string} [group]
   * @param {object} [opts]  { sound, level, icon, clickUrl, badge }
   */
  async function send(title, body = "", group, opts = {}) {
    const attemptedAt = new Date().toISOString();
    if (!cfg.hasUrl && !cfg.hasKey) {
      const result = { ok: false, reason: "bark not configured" };
      _recordDiag(result, attemptedAt);
      return result;
    }
    if (!cfg.enabled) {
      const result = { ok: false, reason: "bark disabled" };
      _recordDiag(result, attemptedAt);
      return result;
    }

    const usedGroup = group || cfg.group;
    const usedSound = opts.sound || cfg.sound;
    const usedLevel = opts.level || cfg.level;
    const usedIcon = opts.icon || cfg.iconUrl;
    const usedClickUrl = opts.clickUrl || cfg.clickUrl;
    const usedBadge = opts.badge !== undefined && opts.badge !== null ? opts.badge : cfg.badge;

    const url = buildUrl(title, body, usedGroup, usedSound, usedLevel, usedIcon, usedClickUrl, usedBadge);

    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === 200) {
        const result = { ok: true, bark_id: data.message || "ok" };
        _recordDiag(result, attemptedAt);
        return result;
      }
      const result = { ok: false, error: data.message || "unknown bark error" };
      _recordDiag(result, attemptedAt);
      return result;
    } catch (err) {
      const result = { ok: false, error: "notification failed" };
      _recordDiag(result, attemptedAt);
      return result;
    }
  }

  /**
   * Send a test notification with rich format.
   * Returns safe metadata only, no endpoint/key values.
   */
  async function testSend() {
    const attemptedAt = new Date().toISOString();
    const endpointKind = cfg.hasUrl ? "url" : cfg.hasKey ? "key" : "none";

    if (!cfg.hasUrl && !cfg.hasKey) {
      return {
        ok: false,
        attempted_at: attemptedAt,
        response_code: null,
        response_message: null,
        source: _determineSource(),
        group: cfg.group,
        endpoint_kind: endpointKind,
        error_short: "bark not configured"
      };
    }
    if (!cfg.enabled) {
      return {
        ok: false,
        attempted_at: attemptedAt,
        response_code: null,
        response_message: null,
        source: _determineSource(),
        group: cfg.group,
        endpoint_kind: endpointKind,
        error_short: "bark disabled"
      };
    }

    const { title, body } = formatManualTestNotification();
    const opts = {};
    if (cfg.hasIcon) opts.icon = cfg.iconUrl;
    if (cfg.hasClickUrl) opts.clickUrl = cfg.clickUrl;
    const result = await send(title, body, "gptwork-test", opts);

    return {
      ok: result.ok,
      attempted_at: _diag.last_attempt_at,
      response_code: _diag.last_response_code,
      response_message: result.ok ? (_diag.last_response_message || "ok") : null,
      source: _determineSource(),
      group: cfg.group,
      endpoint_kind: endpointKind,
      error_short: result.ok ? null : (result.reason || result.error || null)
    };
  }

  /**
   * Return safe status info (no real endpoint/key values exposed).
   */
  function getStatus() {
    return {
      enabled: cfg.enabled,
      configured: cfg.hasUrl || cfg.hasKey,
      source: _determineSource(),
      url_set: cfg.hasUrl,
      key_set: cfg.hasKey,
      icon_set: cfg.hasIcon,
      url_action_set: cfg.hasClickUrl,
      group: cfg.group,
      sound_set: Boolean(cfg.sound),
      level_set: Boolean(cfg.level),
      last_attempt_at: _diag.last_attempt_at,
      last_success_at: _diag.last_success_at,
      last_failure_at: _diag.last_failure_at,
      last_response_code: _diag.last_response_code,
      last_response_message: _diag.last_response_message,
      last_error_short: _diag.last_error_short,
      last_task_id: _diag.last_task_id,
      last_task_status: _diag.last_task_status
    };
  }

  /**
   * Return raw diagnostic state for persistence (safe metadata only).
   */
  function getDiag() {
    return {
      channel: "bark",
      attempted_at: _diag.last_attempt_at,
      ok: _diag.last_error_short === null && _diag.last_attempt_at !== null,
      response_code: _diag.last_response_code,
      response_message: _diag.last_response_message,
      error_short: _diag.last_error_short,
      source: _determineSource(),
      group: cfg.group,
      endpoint_kind: cfg.hasUrl ? "url" : cfg.hasKey ? "key" : "none",
      icon_set: cfg.hasIcon,
      url_action_set: cfg.hasClickUrl
    };
  }

  function _determineSource() {
    if (!cfg.enabled) return "disabled";
    const s = cfg._sources;
    const hasOpt = s.barkUrl === "options" || s.barkKey === "options" || s.barkEnabled === "options";
    const hasEnv = s.barkUrl === "process.env" || s.barkKey === "process.env" || s.barkEnabled === "process.env";
    if (hasOpt && hasEnv) return "mixed";
    if (hasOpt) return "options";
    if (hasEnv) {
      if (configSource === "workspace-runtime-env" || configSource.startsWith("workspace-")) return configSource;
      return "process.env";
    }
    return "unknown";
  }

  return { isEnabled, send, testSend, getStatus, getDiag };
}

// ================================================================
// Notification policy
// ================================================================

/**
 * Classify a task for notification policy compliance.
 *
 * Default policy: notify only for user-visible builder/deploy/admin tasks
 * reaching completed, failed, timed_out, or waiting_for_review status.
 * Suppressed by default: readonly, internal, test, cancelled tasks.
 *
 * @param {object} task   Task object with { mode, status, title }
 * @param {object} [policy]  Optional policy overrides
 * @returns {{ should_notify: boolean, reason: string }}
 */
export function classifyNotification(task, policy = {}) {
  const notifyTasks = policy.notifyTasks ?? process.env.GPTWORK_BARK_NOTIFY_TASKS !== "false";
  const notifyReadonly = policy.notifyReadonly ?? process.env.GPTWORK_BARK_NOTIFY_READONLY === "true";
  const notifyInternal = policy.notifyInternal ?? process.env.GPTWORK_BARK_NOTIFY_INTERNAL === "true";
  const notifyTests = policy.notifyTests ?? process.env.GPTWORK_BARK_NOTIFY_TESTS === "true";
  const notifyCancelled = policy.notifyCancelled ?? process.env.GPTWORK_BARK_NOTIFY_CANCELLED === "true";
  const notifyWaitingReview = policy.notifyWaitingReview ?? process.env.GPTWORK_BARK_NOTIFY_WAITING_REVIEW !== "false";
  const notifyFailures = policy.notifyFailures ?? process.env.GPTWORK_BARK_NOTIFY_FAILURES !== "false";
  const notifyTimeouts = policy.notifyTimeouts ?? process.env.GPTWORK_BARK_NOTIFY_TIMEOUTS !== "false";
  const notifyCompleted = policy.notifyCompleted ?? process.env.GPTWORK_BARK_NOTIFY_COMPLETED !== "false";

  if (!notifyTasks) {
    return { should_notify: false, reason: "notifications globally disabled (GPTWORK_BARK_NOTIFY_TASKS)" };
  }

  const mode = (task.mode || "").toLowerCase();
  const status = (task.status || "").toLowerCase();
  const title = (task.title || "").toLowerCase();

  // Suppress readonly tasks by default
  if (mode === "readonly" && !notifyReadonly) {
    return { should_notify: false, reason: "readonly task suppressed by policy" };
  }

  // Suppress internal tasks by default
  if (mode === "internal" && !notifyInternal) {
    return { should_notify: false, reason: "internal task suppressed by policy" };
  }

  // Suppress test mode tasks by default
  if (mode === "test" && !notifyTests) {
    return { should_notify: false, reason: "test task suppressed by policy" };
  }

  // Suppress Codex session inventory tasks
  if (title.includes("codex session inventory") && !notifyInternal) {
    return { should_notify: false, reason: "session inventory suppressed by policy" };
  }

  // Suppress cancelled by default
  if (status === "cancelled" && !notifyCancelled) {
    return { should_notify: false, reason: "cancelled suppressed by policy" };
  }

  // Status-based filtering
  if (status === "completed" && !notifyCompleted) {
    return { should_notify: false, reason: "completed suppressed by policy" };
  }
  if ((status === "failed" || status === "codex_error") && !notifyFailures) {
    return { should_notify: false, reason: "failure suppressed by policy" };
  }
  if ((status === "timed_out" || status === "codex_timeout") && !notifyTimeouts) {
    return { should_notify: false, reason: "timeout suppressed by policy" };
  }
  if ((status === "waiting_review" || status === "waiting_for_review") && !notifyWaitingReview) {
    return { should_notify: false, reason: "waiting review suppressed by policy" };
  }

  // Only notify for terminal/user-visible statuses
  const notifyStatuses = [
    "completed", "failed", "codex_error", "codex_timeout",
    "timed_out", "waiting_review", "waiting_for_review",
    "cancelled"
  ];
  if (!notifyStatuses.includes(status)) {
    return { should_notify: false, reason: `status "${status}" not in notification targets` };
  }

  return { should_notify: true, reason: "policy allows notification" };
}

// ================================================================
// Notification formatters
// ================================================================

/**
 * Format a notification title and body for a task status change.
 * Uses emoji fallback in title.
 *
 * @param {object} task   Task object
 * @param {string} status Task status string
 * @returns {{ title: string, body: string }}
 */
export function formatNotification(task, status) {
  const shortTitle = (task.title || "(no title)").slice(0, 80);
  const emoji = STATUS_EMOJI[status] || "\uD83D\uDD14";
  const displayStatus = status.replace(/_/g, " ");
  const title = `${emoji} GPTWork ${displayStatus}: ${shortTitle}`;

  let body = `Task: ${shortTitle}\n`;
  body += `Status: ${status}\n`;

  const mode = task.mode || "";
  const ws = task.workspace_id || "";
  if (mode || ws) {
    if (mode) body += `Mode: ${mode}`;
    if (mode && ws) body += " | ";
    if (ws) body += `Workspace: ${ws}`;
    body += "\n";
  }

  if (task.result?.tests) {
    body += `Tests: ${task.result.tests}\n`;
  }

  const commit = task.result?.commit ? task.result.commit.slice(0, 7) : "";
  const remoteHead = task.result?.remote_head ? task.result.remote_head.slice(0, 7) : "";
  if (commit || remoteHead) {
    if (commit) body += `Commit: ${commit}`;
    if (commit && remoteHead) body += " | ";
    if (remoteHead) body += `Remote: ${remoteHead}`;
    body += "\n";
  }

  if (task.duration) {
    const dur = typeof task.duration === "number" ? formatDuration(task.duration) : task.duration;
    body += `Duration: ${dur}\n`;
  } else if (task.result?.completed_at && task.created_at) {
    const durMs = new Date(task.result.completed_at) - new Date(task.created_at);
    if (durMs > 0) {
      body += `Duration: ${formatDuration(durMs)}\n`;
    }
  }

  if (task.result?.summary) {
    const lines = task.result.summary.split("\n").filter(l => l.trim()).slice(0, 2);
    if (lines.length > 0) {
      body += `Summary: ${lines.join(" | ").slice(0, 300)}\n`;
    }
  }

  if (task.result?.changed_files) {
    const files = Array.isArray(task.result.changed_files)
      ? task.result.changed_files.join(", ").slice(0, 200)
      : String(task.result.changed_files).slice(0, 200);
    if (files.trim()) body += `Files: ${files}\n`;
  }

  if (task.result?.kind) body += `Kind: ${task.result.kind}\n`;
  if (task.result?.reason) body += `Reason: ${task.result.reason}\n`;
  if (task.result?.next_action) body += `Next: ${task.result.next_action}\n`;

  // Truncate to mobile-friendly size
  if (body.length > 4000) body = body.slice(0, 3997) + "...";

  return { title, body };
}

/**
 * Format a manual test notification.
 * Uses 🧪 prefix and rich body.
 *
 * @returns {{ title: string, body: string }}
 */
export function formatManualTestNotification() {
  const title = "\uD83E\uDDEA GPTWork Bark test";
  const body = [
    "This is a manual Bark notification test.",
    "",
    "If you can read this, Bark notifications are working correctly.",
    `Timestamp: ${new Date().toISOString()}`
  ].join("\n");
  return { title, body };
}
