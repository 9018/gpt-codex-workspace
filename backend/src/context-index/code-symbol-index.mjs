function stripLineComment(line) {
  const index = line.indexOf("//");
  return index >= 0 ? line.slice(0, index) : line;
}

function braceDelta(line) {
  const source = stripLineComment(line);
  let delta = 0;
  let quote = null;
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") delta += 1;
    if (char === "}") delta -= 1;
  }
  return delta;
}

function declarationEndLine(lines, startIndex) {
  let depth = 0;
  let sawBrace = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const delta = braceDelta(lines[index]);
    if (delta > 0) sawBrace = true;
    depth += delta;
    if (sawBrace && depth <= 0) return index + 1;
    if (!sawBrace && /;\s*$/.test(stripLineComment(lines[index]))) return index + 1;
  }
  return startIndex + 1;
}

function importNames(clause) {
  const names = [];
  const normalized = clause.trim();
  const defaultMatch = normalized.match(/^([A-Za-z_$][\w$]*)/);
  if (defaultMatch && !normalized.startsWith("{")) names.push(defaultMatch[1]);
  const namespaceMatch = normalized.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) names.push(namespaceMatch[1]);
  const namedMatch = normalized.match(/\{([^}]*)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(",")) {
      const value = part.trim();
      if (!value) continue;
      const alias = value.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.push(alias?.[1] || value.split(/\s+/)[0]);
    }
  }
  return [...new Set(names)].sort();
}

function addSymbol(symbols, symbol) {
  if (!symbols.some((entry) => entry.name === symbol.name && entry.start_line === symbol.start_line)) {
    symbols.push(symbol);
  }
}

export function buildCodeSymbolIndex({ filePath, source }) {
  const file_path = String(filePath || "");
  const text = String(source || "");
  const lines = text.split("\n");
  const imports = [];
  const symbols = [];
  const exportNames = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index]);
    const importMatch = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/);
    if (importMatch) {
      imports.push({ source: importMatch[2], names: importNames(importMatch[1]), line: index + 1 });
    }

    const declarationMatch = line.match(/^\s*(export\s+)?(?:default\s+)?(async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)/);
    if (declarationMatch) {
      const exported = Boolean(declarationMatch[1]);
      const name = declarationMatch[4];
      addSymbol(symbols, {
        name,
        kind: declarationMatch[3],
        exported,
        start_line: index + 1,
        end_line: declarationEndLine(lines, index),
      });
      if (exported) exportNames.add(name);
      continue;
    }

    const variableMatch = line.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
    if (variableMatch) {
      const exported = Boolean(variableMatch[1]);
      const name = variableMatch[2];
      const value = variableMatch[3];
      const kind = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(value) ? "function" : "variable";
      addSymbol(symbols, {
        name,
        kind,
        exported,
        start_line: index + 1,
        end_line: declarationEndLine(lines, index),
      });
      if (exported) exportNames.add(name);
    }

    const exportListMatch = line.match(/^\s*export\s*\{([^}]*)\}/);
    if (exportListMatch) {
      for (const part of exportListMatch[1].split(",")) {
        const value = part.trim();
        if (!value) continue;
        const match = value.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!match) continue;
        exportNames.add(match[1]);
        exportNames.add(match[2] || match[1]);
        const symbol = symbols.find((entry) => entry.name === match[1]);
        if (symbol) symbol.exported = true;
      }
    }
  }

  const references = {};
  for (const symbol of symbols) {
    const matches = [];
    const pattern = new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripLineComment(lines[index]);
      if (!pattern.test(line)) {
        pattern.lastIndex = 0;
        continue;
      }
      pattern.lastIndex = 0;
      matches.push({
        file_path,
        line: index + 1,
        kind: index + 1 === symbol.start_line ? "declaration" : "reference",
      });
    }
    references[symbol.name] = matches;
  }

  return {
    file_path,
    line_count: lines.length,
    imports,
    exports: [...exportNames].sort(),
    symbols: symbols.sort((a, b) => a.start_line - b.start_line || a.name.localeCompare(b.name)),
    references,
  };
}

export function findSymbolReferences(index, symbolName) {
  return [...(index?.references?.[symbolName] || [])];
}

export function readSymbolRange({ index, source, symbolName, maxLines = 200 }) {
  const symbol = index?.symbols?.find((entry) => entry.name === symbolName);
  if (!symbol) return null;
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(maxLines) || 200)));
  const endLine = Math.min(symbol.end_line, symbol.start_line + cap - 1);
  const lines = String(source || "").split("\n");
  return {
    file_path: index.file_path,
    symbol: symbol.name,
    start_line: symbol.start_line,
    end_line: endLine,
    truncated: endLine < symbol.end_line,
    content: lines.slice(symbol.start_line - 1, endLine).join("\n"),
  };
}
