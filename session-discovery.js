"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeConfiguredPath(value) {
  if (!value) return value;
  let expanded = String(value);
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}

function normalizeNames(names) {
  const values = Array.isArray(names) ? names : [names];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function createSessionNameMatcher(names, options = {}) {
  const wanted = new Set(normalizeNames(names));
  const token = String(options.numericToken || "").trim();
  const numericPattern = /^\d+$/.test(token)
    ? new RegExp(`(^|\\D)${token}(?=\\D|$)`)
    : null;

  return {
    candidates: numericPattern ? [...wanted, token] : [...wanted],
    numericToken: numericPattern ? token : "",
    match(name) {
      if (wanted.has(name)) return "exact";
      return numericPattern?.test(name) ? "number" : null;
    },
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionNameRecordPatterns(recordType, nameField, names, numericToken = "") {
  const type = `"type"\\s*:\\s*"${escapeRegex(recordType)}"`;
  const fieldPrefix = `"${escapeRegex(nameField)}"\\s*:\\s*`;
  const patterns = normalizeNames(names).map((name) => {
    const encoded = JSON.stringify(name).slice(1, -1);
    const field = `${fieldPrefix}"${escapeRegex(encoded)}"`;
    return `(?:${type}[^\\r\\n]*${field}|${field}[^\\r\\n]*${type})`;
  });

  const token = String(numericToken || "").trim();
  if (/^\d+$/.test(token)) {
    const encoded = escapeRegex(token);
    const value = `"(?:${encoded}(?:[^0-9"]|")|[^"\\r\\n]*[^0-9"]${encoded}(?:[^0-9"]|"))`;
    const field = `${fieldPrefix}${value}`;
    patterns.push(`(?:${type}[^\\r\\n]*${field}|${field}[^\\r\\n]*${type})`);
  }

  return [...new Set(patterns)];
}

async function walkJsonlFiles(root, options = {}) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!options.skipDirectory?.(entry.name, fullPath)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function filesContainingAny(root, names, options = {}) {
  const patterns = sessionNameRecordPatterns(
    options.recordType,
    options.nameField,
    names,
    options.numericToken,
  );
  if (patterns.length === 0 || !fs.existsSync(root)) return [];
  const args = ["-l", "--no-messages", "--glob", "*.jsonl"];
  for (const directory of options.excludedDirectories || []) {
    args.push("--glob", `!**/${directory}/**`);
  }
  for (const pattern of patterns) args.push("-e", pattern);
  args.push("--", root);

  const rg = spawnSync("rg", args, { encoding: "utf8" });
  if (!rg.error && (rg.status === 0 || rg.status === 1)) {
    return rg.status === 0 ? rg.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  const files = await walkJsonlFiles(root, options);
  const matches = [];
  for (const file of files) {
    try {
      const content = await fsp.readFile(file, "utf8");
      if (patterns.some((pattern) => new RegExp(pattern).test(content))) matches.push(file);
    } catch {
      // A session can be removed while discovery is running.
    }
  }
  return matches;
}

async function forEachJsonLine(file, visit) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        visit(JSON.parse(line));
      } catch {
        // Ignore malformed or partially written records.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function fileModifiedMs(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function parsePiSession(file) {
  let header = null;
  let name;
  await forEachJsonLine(file, (entry) => {
    if (!header && entry?.type === "session") header = entry;
    if (entry?.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    }
  });
  if (!header?.id) return null;
  return {
    harness: "pi",
    name,
    id: String(header.id),
    ref: file,
    path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    modifiedMs: await fileModifiedMs(file),
  };
}

async function parseClaudeSession(file) {
  let name;
  let id = path.basename(file, ".jsonl");
  let cwd = "";
  await forEachJsonLine(file, (entry) => {
    if (entry?.type === "custom-title") {
      name = typeof entry.customTitle === "string" && entry.customTitle.trim()
        ? entry.customTitle.trim()
        : undefined;
    }
    if (typeof entry?.sessionId === "string") id = entry.sessionId;
    if (typeof entry?.cwd === "string" && entry.cwd) cwd = entry.cwd;
    if (entry?.type === "relocated" && typeof entry.relocatedCwd === "string") {
      cwd = entry.relocatedCwd;
    }
  });
  return {
    harness: "claude",
    name,
    id,
    ref: id,
    path: file,
    cwd,
    modifiedMs: await fileModifiedMs(file),
  };
}

async function readCodexSessionMeta(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        return entry?.type === "session_meta" && entry.payload ? entry.payload : null;
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function parseCodexNameIndex(content) {
  const latest = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id === "string") latest.set(entry.id, entry);
    } catch {
      // Ignore malformed or partially written records.
    }
  }
  return latest;
}

async function discoverPiSessions(names, env = process.env, options = {}) {
  const matcher = createSessionNameMatcher(names, options);
  const agentDir = normalizeConfiguredPath(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const settings = readJsonFile(path.join(agentDir, "settings.json"));
  const root = normalizeConfiguredPath(
    env.PI_CODING_AGENT_SESSION_DIR || settings?.sessionDir || path.join(agentDir, "sessions"),
  );
  const candidates = await filesContainingAny(root, matcher.candidates, {
    recordType: "session_info",
    nameField: "name",
    numericToken: matcher.numericToken,
  });
  const sessions = [];
  for (const file of candidates) {
    try {
      const session = await parsePiSession(file);
      const matchKind = session?.name ? matcher.match(session.name) : null;
      if (matchKind) sessions.push({ ...session, matchKind });
    } catch {
      // A session can be moved or removed while discovery is running.
    }
  }
  return sessions;
}

async function discoverClaudeSessions(names, env = process.env, options = {}) {
  const matcher = createSessionNameMatcher(names, options);
  const claudeDir = normalizeConfiguredPath(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const root = path.join(claudeDir, "projects");
  const candidates = await filesContainingAny(root, matcher.candidates, {
    recordType: "custom-title",
    nameField: "customTitle",
    numericToken: matcher.numericToken,
    excludedDirectories: ["subagents"],
    skipDirectory: (directoryName) => directoryName === "subagents",
  });
  const sessions = [];
  for (const file of candidates) {
    if (file.split(path.sep).includes("subagents")) continue;
    try {
      const session = await parseClaudeSession(file);
      const matchKind = session?.name ? matcher.match(session.name) : null;
      if (matchKind) sessions.push({ ...session, matchKind });
    } catch {
      // A session can be moved or removed while discovery is running.
    }
  }
  return sessions;
}

async function discoverCodexSessions(names, env = process.env, options = {}) {
  const matcher = createSessionNameMatcher(names, options);
  const codexDir = normalizeConfiguredPath(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  let content;
  try {
    content = await fsp.readFile(path.join(codexDir, "session_index.jsonl"), "utf8");
  } catch {
    return [];
  }

  const matches = [...parseCodexNameIndex(content).values()]
    .map((entry) => ({ entry, matchKind: matcher.match(entry.thread_name) }))
    .filter((match) => match.matchKind);
  if (matches.length === 0) return [];

  const ids = new Set(matches.map((match) => match.entry.id));
  const roots = [path.join(codexDir, "sessions"), path.join(codexDir, "archived_sessions")];
  const files = (await Promise.all(roots.map((root) => walkJsonlFiles(root)))).flat();
  const fileById = new Map();
  for (const file of files) {
    for (const id of ids) {
      if (path.basename(file).includes(id)) fileById.set(id, file);
    }
  }

  const sessions = [];
  for (const match of matches) {
    const { entry, matchKind } = match;
    const file = fileById.get(entry.id);
    if (!file) continue;
    const meta = await readCodexSessionMeta(file);
    const metaId = meta?.id || meta?.session_id;
    if (metaId !== entry.id) continue;
    sessions.push({
      harness: "codex",
      name: entry.thread_name,
      id: entry.id,
      ref: entry.id,
      path: file,
      cwd: typeof meta.cwd === "string" ? meta.cwd : "",
      modifiedMs: await fileModifiedMs(file),
      matchKind,
    });
  }
  return sessions;
}

async function codexSessionIdsWithName(name, env = process.env) {
  const codexDir = normalizeConfiguredPath(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  try {
    const content = await fsp.readFile(path.join(codexDir, "session_index.jsonl"), "utf8");
    return [...parseCodexNameIndex(content).values()]
      .filter((entry) => entry.thread_name === name)
      .map((entry) => entry.id);
  } catch {
    return [];
  }
}

async function discoverNamedSessions(names, env = process.env, options = {}) {
  const groups = await Promise.all([
    discoverPiSessions(names, env, options),
    discoverCodexSessions(names, env, options),
    discoverClaudeSessions(names, env, options),
  ]);
  return groups.flat();
}

function liveAgentForSession(session, agents) {
  return agents.find((agent) => {
    const native = agent?.agent_session;
    if (!native || native.agent !== session.harness) return false;
    if (session.harness === "pi") {
      if (native.kind === "path") return path.resolve(native.value) === path.resolve(session.ref);
      return native.kind === "id" && native.value === session.id;
    }
    return native.kind === "id" && native.value === session.id;
  }) || null;
}

function attachLiveAgents(sessions, agents) {
  return sessions.map((session) => ({
    ...session,
    liveAgent: liveAgentForSession(session, agents),
  }));
}

function orderSessionsForCwd(sessions, cwd) {
  return [...sessions].sort((a, b) => {
    const aExact = a.matchKind === "exact" ? 1 : 0;
    const bExact = b.matchKind === "exact" ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aLive = a.liveAgent ? 1 : 0;
    const bLive = b.liveAgent ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const aLocal = a.cwd && path.resolve(a.cwd) === path.resolve(cwd) ? 1 : 0;
    const bLocal = b.cwd && path.resolve(b.cwd) === path.resolve(cwd) ? 1 : 0;
    if (aLocal !== bLocal) return bLocal - aLocal;
    return b.modifiedMs - a.modifiedMs;
  });
}

module.exports = {
  attachLiveAgents,
  codexSessionIdsWithName,
  discoverNamedSessions,
  discoverPiSessions,
  discoverCodexSessions,
  discoverClaudeSessions,
  normalizeConfiguredPath,
  orderSessionsForCwd,
  parseClaudeSession,
  parseCodexNameIndex,
  parsePiSession,
  sessionNameRecordPatterns,
};
