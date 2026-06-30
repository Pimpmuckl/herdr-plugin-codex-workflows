#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { spawn, spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || __dirname;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || pluginRoot;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || configDir;
const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON) || {};

const AGENT_DETECT_POLL_MS = 1000;
const AGENT_COMMAND_START_TIMEOUT_MS = 2000;
const AGENT_COMMAND_SETTLE_MS = 700;

const defaultConfig = {
  defaultAgent: "codex",
  agents: {
    codex: { command: "codex", renameCommand: "/rename {sessionId}" },
    claude: { command: "claude", renameCommand: "/rename {sessionId}" },
    pi: { command: "pi --name {sessionId}", renameCommand: "" },
  },
  promptTemplate: "see {url}, lets discuss the problem,shape,kiss fix",
  tabLabelTemplate: "{sessionId} {repoName}",
  sessionIdTemplate: "gh-{kind}-{number}",
  unknownSessionId: "gh-item",
  timing: {
    agentDetectTimeoutMs: 5000,
    agentIdleTimeoutMs: 30000,
    afterOverlayCloseFocusMs: 400,
  },
};

function readJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`failed to read ${file}: ${error.message}`);
  }
}

function seedConfigFile() {
  const target = path.join(configDir, "config.json");
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(configDir, { recursive: true });
  const example = path.join(pluginRoot, "config.example.json");
  const content = fs.existsSync(example)
    ? fs.readFileSync(example, "utf8")
    : `${JSON.stringify(defaultConfig, null, 2)}\n`;
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function mergeConfig(base, override) {
  if (!override || typeof override !== "object") return base;
  const merged = { ...base, ...override };
  merged.agents = { ...base.agents, ...(override.agents || {}) };
  merged.timing = { ...base.timing, ...(override.timing || {}) };
  return merged;
}

function loadConfig() {
  return mergeConfig(defaultConfig, readJsonFile(seedConfigFile()));
}

function runHerdr(args, options = {}) {
  const result = spawnSync(herdr, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) {
    throw new Error(`${herdr} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(`${herdr} ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function runHerdrJson(args) {
  const stdout = runHerdr(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${herdr} ${args.join(" ")} returned non-JSON output: ${stdout.trim()}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function focusTabAfterOverlayCloses(tabId, delayMs) {
  const code = `
    const { spawnSync } = require("node:child_process");
    const delay = Number(process.argv[3] || "400");
    setTimeout(() => {
      spawnSync(process.argv[1], ["tab", "focus", process.argv[2]], { stdio: "ignore" });
    }, delay);
  `;
  const child = spawn(process.execPath, ["-e", code, herdr, tabId, String(delayMs)], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

function parseItem(raw, config) {
  const item = raw.trim();
  if (!item) return null;

  const url = item.match(/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|discussions|pull)\/([0-9]+)/i);
  if (url) {
    return normalizeItem({
      raw: item,
      repo: url[1],
      kind: url[2].toLowerCase(),
      number: url[3],
      url: item.startsWith("http") ? item : `https://${item}`,
    }, config);
  }

  const number = item.match(/^#?([0-9]+)$/);
  if (number) {
    return normalizeItem({ raw: item, kind: "issue", number: number[1] }, config);
  }

  const words = item.match(/^(issue|issues|discussion|discussions|pull|pr)[\s#-]*([0-9]+)$/i);
  if (words) {
    return normalizeItem({ raw: item, kind: words[1].toLowerCase(), number: words[2] }, config);
  }

  return normalizeItem({ raw: item, kind: "item", number: "" }, config);
}

function normalizeItem(item, config) {
  let kind = item.kind;
  if (kind === "issues") kind = "issue";
  if (kind === "discussions") kind = "discussion";
  if (kind === "pull" || kind === "pr") kind = "pr";
  const repoName = item.repo ? item.repo.split("/").pop() : "";
  const values = { ...item, kind, repoName };
  const sessionId = item.number
    ? renderTemplate(config.sessionIdTemplate, values)
    : config.unknownSessionId;
  return {
    ...item,
    kind,
    repoName,
    sessionId: sanitizeSessionId(sessionId),
    label: compact(renderTemplate(config.tabLabelTemplate, { ...values, sessionId })),
  };
}

function sanitizeSessionId(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "gh-item";
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return values[key] === undefined || values[key] === null ? "" : String(values[key]);
  });
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=@%+-]*$/.test(text)) return text || "''";
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function renderShellTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return shellQuote(values[key]);
  });
}

function normalizeAgent(value, config) {
  const agent = value.trim().toLowerCase();
  if (!agent) return "";
  if (agent === "c" && config.agents.codex) return "codex";
  if ((agent === "cl" || agent === "claude") && config.agents.claude) return "claude";
  if (config.agents[agent]) return agent;
  return "";
}

function readDefaultAgent(config) {
  const file = path.join(stateDir, "default-agent");
  try {
    const value = normalizeAgent(fs.readFileSync(file, "utf8"), config);
    return value || normalizeAgent(config.defaultAgent, config) || Object.keys(config.agents)[0] || "codex";
  } catch {
    return normalizeAgent(config.defaultAgent, config) || Object.keys(config.agents)[0] || "codex";
  }
}

function writeDefaultAgent(agent) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "default-agent"), `${agent}\n`, "utf8");
}

function agentCommand(agent, config, item) {
  const command = config.agents?.[agent]?.command;
  if (Array.isArray(command)) {
    return command.map((part) => renderShellTemplate(part, item)).join(" ");
  }
  return renderShellTemplate(String(command || agent), item);
}

function renameCommand(agent, config, item) {
  const agentConfig = config.agents?.[agent] || {};
  const template = Object.hasOwn(agentConfig, "renameCommand")
    ? agentConfig.renameCommand
    : "/rename {sessionId}";
  return renderTemplate(template, item).trim();
}

function discussionPrompt(config, item) {
  const target = item.url || item.raw;
  return renderTemplate(config.promptTemplate, { ...item, url: target });
}

function timingValue(config, key, fallback) {
  const value = Number(config.timing?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function agentStatus(paneId) {
  try {
    const response = runHerdrJson(["agent", "get", paneId]);
    return response?.result?.agent?.agent_status || null;
  } catch {
    return null;
  }
}

function waitForAgentDetected(paneId, config) {
  const timeoutMs = timingValue(config, "agentDetectTimeoutMs", 5000);
  const pollMs = AGENT_DETECT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (agentStatus(paneId)) return true;
    sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  return false;
}

function waitForAgentIdle(paneId, config, action) {
  const timeoutMs = timingValue(config, "agentIdleTimeoutMs", 30000);
  try {
    runHerdr(["agent", "wait", paneId, "--status", "idle", "--timeout", String(timeoutMs)]);
  } catch (error) {
    throw new Error(`${action} did not reach idle state within ${timeoutMs}ms: ${error.message}`);
  }
}

function waitForAgentReady(paneId, config) {
  if (!waitForAgentDetected(paneId, config)) {
    const timeoutMs = timingValue(config, "agentDetectTimeoutMs", 5000);
    throw new Error(
      `Herdr did not detect an agent in pane ${paneId} within ${timeoutMs}ms; configured commands must start a Herdr-detectable agent`,
    );
  }
  waitForAgentIdle(paneId, config, "agent startup");
}

function waitForAgentTurnAfterSubmit(paneId, config, action) {
  const timeoutMs = AGENT_COMMAND_START_TIMEOUT_MS;
  const pollMs = Math.min(100, AGENT_DETECT_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = agentStatus(paneId);
    if (status && status !== "idle") {
      waitForAgentIdle(paneId, config, action);
      return;
    }
    sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  sleep(AGENT_COMMAND_SETTLE_MS);
  waitForAgentIdle(paneId, config, action);
}

async function main() {
  const config = loadConfig();
  output.write("\x1b[2J\x1b[H");
  output.write("GitHub Start\n\n");

  const rl = readline.createInterface({ input, output });
  const defaultAgent = readDefaultAgent(config);
  const agents = Object.keys(config.agents);

  const rawItem = await rl.question("GitHub issue/discussion URL or number: ");
  const item = parseItem(rawItem, config);
  if (!item) {
    output.write("\nCancelled.\n");
    rl.close();
    return;
  }

  let agent = "";
  while (!agent) {
    const answer = await rl.question(`Agent [${agents.join("/")}] (${defaultAgent}): `);
    agent = normalizeAgent(answer, config) || (!answer.trim() ? defaultAgent : "");
    if (!agent) output.write(`Type one of: ${agents.join(", ")}.\n`);
  }
  rl.close();
  writeDefaultAgent(agent);

  const cwd = context.workspace_cwd || context.focused_pane_cwd || process.env.PWD || process.cwd();
  output.write(`\nCreating tab ${item.label}...\n`);
  const tabResponse = runHerdrJson(["tab", "create", "--label", item.label, "--cwd", cwd, "--focus"]);
  const tabId = tabResponse?.result?.tab?.tab_id;
  const paneId = tabResponse?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) {
    throw new Error("tab.create response did not include tab_id and root_pane.pane_id");
  }

  output.write(`Starting ${agent} as ${item.sessionId}...\n`);
  runHerdr(["pane", "rename", paneId, item.sessionId]);
  runHerdr(["pane", "run", paneId, agentCommand(agent, config, item)]);
  output.write("Waiting for Herdr to detect the agent and for it to become idle...\n");
  waitForAgentReady(paneId, config);
  const rename = renameCommand(agent, config, item);
  if (rename) {
    runHerdr(["pane", "run", paneId, rename]);
    waitForAgentTurnAfterSubmit(paneId, config, "rename command");
  }
  runHerdr(["pane", "run", paneId, discussionPrompt(config, item)]);
  focusTabAfterOverlayCloses(tabId, config.timing.afterOverlayCloseFocusMs);
  output.write(`Done. ${agent} is running in ${tabId} as ${item.sessionId}.\n`);
}

main().catch((error) => {
  output.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});

