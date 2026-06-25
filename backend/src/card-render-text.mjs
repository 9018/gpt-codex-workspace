function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function valueText(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function truncate(value, max = 180) {
  const text = valueText(value);
  return text.length > max ? text.slice(0, Math.max(0, max - 3)) + "..." : text;
}

function statusChip(status, severity) {
  const sev = severity || "info";
  if (sev === "ok") return "[OK]";
  if (sev === "error") return "[!!]";
  if (sev === "warning") return "[!]";
  return "[--]";
}

function rowKeyValue(row) {
  if (!isObject(row)) return truncate(row);
  if (row.key !== undefined) return `${row.key}: ${truncate(row.value)}`;
  return Object.entries(row).map(([key, value]) => `${key}=${truncate(value, 80)}`).join("  ");
}

function renderSection(section) {
  const lines = [];
  lines.push(`${section.title || "Section"}:`);
  if (section.type === "text") {
    if (section.text) lines.push(`  ${truncate(section.text, 1200)}`);
    return lines;
  }
  if (section.type === "logs" || section.type === "timeline") {
    for (const item of (section.items || []).slice(0, 10)) {
      if (isObject(item)) lines.push(`  - ${item.time ? `${item.time}  ` : ""}${truncate(item.text || item.message || item.label || item)}`);
      else lines.push(`  - ${truncate(item)}`);
    }
    return lines;
  }
  if (section.type === "checklist") {
    for (const item of (section.items || []).slice(0, 20)) {
      const checked = item?.status === "passed" || item?.status === "ok" || item?.checked === true ? "x" : " ";
      lines.push(`  [${checked}] ${item?.label || item?.key || truncate(item)}${item?.status ? ` (${item.status})` : ""}`);
    }
    return lines;
  }
  if (section.type === "table") {
    for (const row of (section.rows || []).slice(0, 20)) lines.push(`  ${rowKeyValue(row)}`);
    return lines;
  }
  if (Array.isArray(section.items)) {
    for (const item of section.items.slice(0, 20)) lines.push(`  - ${truncate(isObject(item) ? (item.label || item.text || item.message || rowKeyValue(item)) : item)}`);
  }
  if (section.text) lines.push(`  ${truncate(section.text, 1200)}`);
  return lines;
}

export function renderCardText(card) {
  if (!isObject(card)) return JSON.stringify(card);
  const lines = [];
  const title = card.title || "GPTWork Result";
  const status = card.status ? ` ${statusChip(card.status, card.severity)} ${card.status}` : "";
  lines.push(`${title}${status}`);
  lines.push("-".repeat(Math.min(72, Math.max(12, title.length + status.length))));
  if (card.subtitle) lines.push(`  subtitle: ${truncate(card.subtitle)}`);
  if (card.summary) lines.push(`  summary: ${truncate(card.summary, 300)}`);

  if (card.progress?.stages?.length) {
    lines.push("");
    lines.push(`Progress: ${card.progress.current_stage || "-"}`);
    for (const stage of card.progress.stages) {
      const marker = stage.status === "done" ? "x" : stage.status === "current" ? ">" : " ";
      lines.push(`  [${marker}] ${stage.label || stage.key}: ${stage.status}${stage.detail ? ` - ${stage.detail}` : ""}`);
    }
  }

  if (Array.isArray(card.key_values) && card.key_values.length > 0) {
    lines.push("");
    lines.push("Key values:");
    for (const row of card.key_values) lines.push(`  ${row.key}: ${truncate(row.value)}`);
  }

  for (const section of card.sections || []) {
    const rendered = renderSection(section);
    if (rendered.length > 1 || section.text) {
      lines.push("");
      lines.push(...rendered);
    }
  }

  if (Array.isArray(card.diagnostics) && card.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of card.diagnostics.slice(0, 12)) {
      lines.push(`  ${statusChip(diagnostic.severity, diagnostic.severity)} ${diagnostic.severity || "info"}: ${truncate(diagnostic.message)}${diagnostic.code ? ` (${diagnostic.code})` : ""}`);
    }
  }

  if (Array.isArray(card.actions) && card.actions.length > 0) {
    lines.push("");
    lines.push("Actions:");
    for (const action of card.actions.slice(0, 8)) {
      lines.push(`  > ${action.label}${action.tool ? ` (${action.tool})` : ""}`);
    }
  }

  return lines.join("\n");
}
