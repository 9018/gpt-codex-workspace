import { cleanupSystemTmp, getInodePressure } from "./gptwork-tmp.mjs";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function parsePercent(value) {
  const parsed = Number.parseInt(String(value || "0").replace("%", ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function runStorageJanitor({
  getPressure = getInodePressure,
  cleanup = cleanupSystemTmp,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  warningPct = 75,
  criticalPct = 85,
  now = () => new Date().toISOString(),
  onResult,
} = {}) {
  const pressure = await getPressure().catch(() => null);
  const pressurePct = parsePercent(pressure?.used_pct);
  const severity = pressurePct >= criticalPct ? "critical" : pressurePct >= warningPct ? "warning" : "ok";
  try {
    const cleanupResult = await cleanup({
      dryRun: false,
      maxAgeMs,
      maxCount: 5000,
      maxInodes: pressurePct >= warningPct ? 25_000 : 50_000,
    });
    const result = {
      ok: true,
      severity,
      pressure_pct: pressurePct,
      pressure,
      deleted_entries: cleanupResult.deleted || 0,
      deleted_inodes: cleanupResult.deleted_inodes || 0,
      cleanup: cleanupResult,
      completed_at: now(),
    };
    await onResult?.(result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      severity,
      pressure_pct: pressurePct,
      pressure,
      error: error?.message || String(error),
      completed_at: now(),
    };
    await onResult?.(result);
    return result;
  }
}

export function startStorageJanitor({
  run = runStorageJanitor,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onResult,
} = {}) {
  const execute = async () => run({ onResult }).catch(async (error) => {
    const result = { ok: false, severity: "warning", error: error?.message || String(error), completed_at: new Date().toISOString() };
    await onResult?.(result);
    return result;
  });
  const initialRun = execute();
  const timer = setIntervalFn(() => { void execute(); }, intervalMs);
  timer?.unref?.();
  return {
    initialRun,
    stop() { clearIntervalFn(timer); },
  };
}
