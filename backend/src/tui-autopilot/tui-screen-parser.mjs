import { createHash } from "node:crypto";
import { createTuiScreenFrame } from "./tui-screen-model.mjs";

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function unique(values) {
  return [...new Set(values)];
}

export function normalizeTuiText(raw) {
  return String(raw || "")
    .replace(ANSI_PATTERN, "")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim();
}

export function parseTuiScreen(raw, { sequence = 0, capturedAt = null, maxChars = 32_000 } = {}) {
  const rawTail = String(raw || "").slice(-maxChars);
  const normalized = normalizeTuiText(rawTail);
  const lines = normalized.split("\n").filter(Boolean);
  const lower = normalized.toLowerCase();
  const options = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:[>●○*]\s*)?(\d+)[.)]\s+(.+)$/);
    if (match) options.push({ index: Number(match[1]), label: match[2].trim() });
  }
  const confirmations = [];
  if (/(?:allow|approve|confirm|proceed|run|execute).{0,120}(?:\(y\/n\)|\[y\/n\]|yes\/no)/i.test(normalized)) confirmations.push("allow_command");
  const prompts = [];
  if (/(?:^|\n)\s*(?:›|>|codex>)\s*$/i.test(normalized) || /what would you like me to do/i.test(normalized)) prompts.push("codex_prompt");
  const progress = [];
  if (/\b(?:working|running|thinking|analyzing|executing|testing|building)\b/i.test(normalized)) progress.push("working");
  const errors = [];
  if (/\b(?:error|failed|exception|permission denied)\b/i.test(normalized)) errors.push("error_text");
  const terminal = [];
  if (/\b(?:done|completed|finished)\b/i.test(normalized)) terminal.push("done_text");
  return createTuiScreenFrame({
    sequence,
    captured_at: capturedAt || new Date().toISOString(),
    raw_tail: rawTail,
    normalized_text: normalized,
    stable_lines: unique(lines),
    prompt_markers: prompts,
    selectable_options: options,
    confirmation_markers: confirmations,
    error_markers: errors,
    progress_markers: progress,
    terminal_markers: terminal,
    content_digest: createHash("sha256").update(normalized).digest("hex"),
  });
}
