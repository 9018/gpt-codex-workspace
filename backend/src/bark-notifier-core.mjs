import { DEFAULT_BARK_BASE, buildConfig } from "./bark-config.mjs";
import { formatManualTestNotification } from "./bark-notification-formatters.mjs";

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
    last_task_status: null,
    last_task_event: null
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
      last_task_status: _diag.last_task_status,
      last_task_event: _diag.last_task_event
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
      url_action_set: cfg.hasClickUrl,
      last_task_event: _diag.last_task_event
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

  function _setTaskMetadata(taskId, taskStatus, eventType) {
    if (taskId !== undefined) _diag.last_task_id = taskId;
    if (taskStatus !== undefined) _diag.last_task_status = taskStatus;
    if (eventType !== undefined) _diag.last_task_event = eventType;
  }

  return { isEnabled, send, testSend, getStatus, getDiag, _setTaskMetadata };
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
