"use strict";

const { createHash } = require("node:crypto");

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(compact).filter(Boolean))];
}

function agentNameForSession(sessionName) {
  const hash = createHash("sha256").update(sessionName).digest("hex").slice(0, 20);
  return `session-${hash}`;
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return values[key] === undefined || values[key] === null ? "" : String(values[key]);
  });
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(executable, args) {
  return [executable, ...args].map(shellQuote).join(" ");
}

function parseTarget(raw, config) {
  const input = compact(raw);
  if (!input) return null;

  const url = input.match(/(?:https?:\/\/)?github\.com\/([^/\s]+\/[^/\s]+)\/(issues|discussions|pull)\/([0-9]+)/i);
  if (url) {
    return normalizeGitHubTarget({
      raw: input,
      repo: url[1],
      kind: url[2].toLowerCase(),
      number: url[3],
      url: `https://github.com/${url[1]}/${url[2].toLowerCase()}/${url[3]}`,
    }, config);
  }

  const number = input.match(/^#?([0-9]+)$/);
  if (number) {
    return normalizeGitHubTarget({
      raw: input,
      kind: "issue",
      number: number[1],
      url: "",
      numericNameToken: number[1],
    }, config);
  }

  const words = input.match(/^(issue|issues|discussion|discussions|pull|pr)[\s#-]*([0-9]+)$/i);
  if (words) {
    return normalizeGitHubTarget({ raw: input, kind: words[1].toLowerCase(), number: words[2], url: "" }, config);
  }

  return {
    raw: input,
    kind: "name",
    number: "",
    repo: "",
    repoName: "",
    url: "",
    sessionName: input,
    searchNames: [input],
    agentName: agentNameForSession(input),
    label: input,
    shouldPrompt: false,
  };
}

function normalizeGitHubTarget(item, config) {
  let kind = item.kind;
  if (kind === "issues") kind = "issue";
  if (kind === "discussions") kind = "discussion";
  if (kind === "pull" || kind === "pr") kind = "pr";

  const repoName = item.repo ? item.repo.split("/").pop() : "";
  const nameKind = kind === "pr" ? "pull" : kind;
  const values = { ...item, kind, nameKind, repoName };
  const configuredName = repoName
    ? compact(renderTemplate(config.githubSessionNameTemplate, values))
    : "";
  const sessionName = configuredName || item.number;
  const legacyName = `gh-${kind}-${item.number}`;
  const repoNumberName = repoName ? `${repoName}#${item.number}` : "";
  const repoQualifiedName = repoName ? `${repoName}#${kind}-${item.number}` : "";
  const searchNames = unique([
    item.raw,
    sessionName,
    repoQualifiedName,
    repoNumberName,
    item.number,
    legacyName,
  ]);
  const templateValues = { ...values, sessionName, sessionId: sessionName };
  let label = compact(renderTemplate(config.tabLabelTemplate, templateValues)) || sessionName;
  if (repoName && label === `${sessionName} ${repoName}` && sessionName.startsWith(`${repoName}#`)) {
    label = sessionName;
  }

  return {
    ...item,
    kind,
    repoName,
    sessionName,
    searchNames,
    agentName: agentNameForSession(sessionName),
    label,
    shouldPrompt: true,
  };
}

function buildNewArguments(harness, sessionName, contextUrl = "") {
  switch (harness) {
    case "pi": {
      const args = ["--name", sessionName];
      if (contextUrl) args.push("--gh-context-url", contextUrl);
      return args;
    }
    case "claude":
      return ["--name", sessionName];
    case "codex":
      return [];
    default:
      throw new Error(`unsupported harness: ${harness}`);
  }
}

function buildResumeArguments(session, contextUrl = "") {
  switch (session.harness) {
    case "pi": {
      const args = ["--session", session.ref];
      if (contextUrl) args.push("--gh-context-url", contextUrl);
      return args;
    }
    case "codex":
      return ["resume", session.id];
    case "claude":
      return ["--resume", session.id];
    default:
      throw new Error(`unsupported harness: ${session.harness}`);
  }
}

function discussionPrompt(config, target) {
  if (!target.shouldPrompt) return "";
  const url = target.url || target.raw;
  return renderTemplate(config.promptTemplate, { ...target, url, sessionId: target.sessionName });
}

function formatAge(modifiedMs, now = Date.now()) {
  if (!modifiedMs) return "unknown";
  const minutes = Math.max(0, Math.floor((now - modifiedMs) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

module.exports = {
  agentNameForSession,
  buildNewArguments,
  buildShellCommand,
  buildResumeArguments,
  discussionPrompt,
  formatAge,
  parseTarget,
  renderTemplate,
};
