#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { spawnSync } = require("node:child_process");
const {
  agentNameForSession,
  buildNewArguments,
  buildResumeArguments,
  buildShellCommand,
  discussionPrompt,
  formatAge,
  parseTarget,
  renderTemplate,
} = require("./launcher.js");
const {
  attachLiveAgents,
  codexSessionIdsWithName,
  discoverNamedSessions,
  orderSessionsForCwd,
} = require("./session-discovery.js");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || __dirname;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || pluginRoot;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || configDir;
const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON) || {};
const supportedHarnesses = ["pi", "codex", "claude"];

const defaultConfig = {
  defaultAgent: "pi",
  projectRepoName: "herdr",
  agents: {
    codex: { renameCommand: "/rename {sessionName}" },
  },
  githubSessionNameTemplate: "{nameKind}-{number}",
  promptTemplate: "see {url}, lets discuss the problem,shape,kiss fix",
  tabLabelTemplate: "{sessionName}",
  timing: {
    agentStartTimeoutMs: 30000,
    sessionNameTimeoutMs: 5000,
    shellReadyTimeoutMs: 5000,
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
  return {
    ...base,
    ...override,
    githubSessionNameTemplate: override.githubSessionNameTemplate || base.githubSessionNameTemplate,
    projectRepoName: override.projectRepoName || base.projectRepoName,
    agents: {
      codex: { ...base.agents.codex, ...(override.agents?.codex || {}) },
    },
    timing: { ...base.timing, ...(override.timing || {}) },
  };
}

function loadConfig() {
  return mergeConfig(defaultConfig, readJsonFile(seedConfigFile()));
}

function runHerdr(args) {
  const result = spawnSync(herdr, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${herdr} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout || `exit ${result.status}`;
    const error = new Error(`${herdr} ${args.join(" ")} failed: ${detail}`);
    try {
      error.herdrCode = JSON.parse(detail)?.error?.code;
    } catch {
      // Preserve non-JSON command failures as ordinary errors.
    }
    throw error;
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

function normalizeHarness(value) {
  const harness = value.trim().toLowerCase();
  if (!harness) return "";
  const aliases = { p: "pi", c: "codex", cx: "codex", cl: "claude" };
  const normalized = aliases[harness] || harness;
  return supportedHarnesses.includes(normalized) ? normalized : "";
}

function readDefaultHarness(config) {
  const file = path.join(stateDir, "default-agent");
  try {
    const saved = normalizeHarness(fs.readFileSync(file, "utf8"));
    if (saved) return saved;
  } catch {
    // Use configured fallback.
  }
  return normalizeHarness(config.defaultAgent) || "pi";
}

function writeDefaultHarness(harness) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "default-agent"), `${harness}\n`, "utf8");
}

function listLiveAgents() {
  try {
    const response = runHerdrJson(["agent", "list"]);
    return response?.result?.agents || [];
  } catch {
    return [];
  }
}

async function waitForCodexName(sessionName, previousIds, timeoutMs) {
  const baseline = new Set(previousIds);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const namedIds = await codexSessionIdsWithName(sessionName);
    if (namedIds.some((id) => !baseline.has(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Codex did not save session name ${sessionName} within ${timeoutMs}ms`);
}

function describeSession(session, currentCwd) {
  const state = session.liveAgent ? "RUNNING" : "saved  ";
  const cwd = session.cwd || "unknown cwd";
  const local = session.cwd && path.resolve(session.cwd) === path.resolve(currentCwd) ? " | current cwd" : "";
  const id = session.id ? session.id.slice(0, 8) : "unknown";
  return `${state} | ${session.harness.padEnd(6)} | ${formatAge(session.modifiedMs).padStart(4)} | ${id} | ${cwd}${local}`;
}

async function chooseSavedSession(rl, sessions, currentCwd) {
  output.write(`\nFound ${sessions.length} named session match${sessions.length === 1 ? "" : "es"}:\n`);
  sessions.forEach((session, index) => {
    output.write(`  ${index + 1}) ${describeSession(session, currentCwd)}\n`);
    output.write(`     session name: ${session.name}\n`);
  });
  output.write("  n) start a new session\n");
  output.write("  q) cancel\n");

  while (true) {
    const answer = (await rl.question("Choose [1]: ")).trim().toLowerCase();
    if (answer === "n" || answer === "new") return { action: "new" };
    if (answer === "q" || answer === "quit" || answer === "cancel") return { action: "cancel" };
    const index = answer ? Number(answer) - 1 : 0;
    if (Number.isInteger(index) && sessions[index]) {
      return sessions[index].liveAgent
        ? { action: "focus", session: sessions[index] }
        : { action: "resume", session: sessions[index] };
    }
    output.write(`Choose 1-${sessions.length}, n, or q.\n`);
  }
}

async function chooseHarness(rl, config) {
  const fallback = readDefaultHarness(config);
  while (true) {
    const answer = await rl.question(`Start with [pi/codex/claude] (${fallback}): `);
    const harness = normalizeHarness(answer) || (!answer.trim() ? fallback : "");
    if (harness) {
      writeDefaultHarness(harness);
      return harness;
    }
    output.write("Type pi, codex, or claude.\n");
  }
}

function createTab(label, cwd, workspaceId) {
  const command = ["tab", "create"];
  if (workspaceId) command.push("--workspace", workspaceId);
  command.push("--label", label, "--cwd", cwd, "--focus");
  const response = runHerdrJson(command);
  const tabId = response?.result?.tab?.tab_id;
  const paneId = response?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error("tab.create response did not include tab_id and root_pane.pane_id");
  return { tabId, paneId };
}

function findMainProjectWorkspace(config) {
  const response = runHerdrJson(["workspace", "list"]);
  const workspaces = response?.result?.workspaces || [];
  const workspace = workspaces.find((candidate) => {
    const worktree = candidate.worktree;
    return worktree
      && worktree.repo_name === config.projectRepoName
      && worktree.is_linked_worktree === false;
  });
  if (!workspace?.workspace_id || !workspace.worktree?.repo_root) {
    throw new Error(`main ${config.projectRepoName} workspace is not open`);
  }
  return {
    workspaceId: workspace.workspace_id,
    cwd: workspace.worktree.repo_root,
  };
}

function createLaunchLocation(config, label) {
  const project = findMainProjectWorkspace(config);
  output.write(`\nCreating tab "${label}" in the main ${config.projectRepoName} workspace...\n`);
  return { ...createTab(label, project.cwd, project.workspaceId), cwd: project.cwd };
}

async function waitForAvailableShell(paneId, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = runHerdrJson(["pane", "process-info", "--pane", paneId]);
      const info = response?.result?.process_info;
      if (
        info?.shell_pid
        && info.foreground_process_group_id === info.shell_pid
        && info.foreground_processes?.length === 1
        && info.foreground_processes[0].pid === info.shell_pid
      ) {
        return;
      }
    } catch {
      // A newly created pane may not have a live terminal yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pane ${paneId} did not reach an available shell before startup timed out`);
}

async function startAgent(agentName, harness, paneId, args, config) {
  const command = harness === "pi"
    ? ["pane", "run", paneId, buildShellCommand("pi", args)]
    : [
        "agent",
        "start",
        agentName,
        "--kind",
        harness,
        "--pane",
        paneId,
        "--timeout",
        String(config.timing.agentStartTimeoutMs),
        ...(args.length > 0 ? ["--", ...args] : []),
      ];

  const deadline = Date.now() + config.timing.shellReadyTimeoutMs;
  while (Date.now() < deadline) {
    await waitForAvailableShell(paneId, deadline);
    try {
      runHerdr(command);
      return harness === "pi" ? paneId : agentName;
    } catch (error) {
      if (error.herdrCode !== "agent_pane_busy") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pane ${paneId} remained busy until agent startup timed out`);
}

function promptAgent(agentName, text) {
  if (!text) return;
  runHerdr(["agent", "prompt", agentName, text]);
}

async function main() {
  const config = loadConfig();
  const currentCwd = context.workspace_cwd || context.focused_pane_cwd || process.env.PWD || process.cwd();
  output.write("\x1b[2J\x1b[H");
  output.write("Find named agent session\n\n");

  const rl = readline.createInterface({ input, output });
  const rawTarget = await rl.question("Exact session name or GitHub target: ");
  const target = parseTarget(rawTarget, config);
  if (!target) {
    rl.close();
    return;
  }

  output.write("\nSearching session names in Pi, Codex, and Claude...\n");
  const liveAgents = listLiveAgents();
  const discovered = await discoverNamedSessions(target.searchNames, process.env, {
    numericToken: target.numericNameToken,
  });
  const sessions = orderSessionsForCwd(attachLiveAgents(discovered, liveAgents), currentCwd);

  let selected;
  if (sessions.length > 0) {
    selected = await chooseSavedSession(rl, sessions, currentCwd);
  } else {
    output.write(`\nNo named session found for "${target.raw}" in Pi, Codex, or Claude.\n`);
    selected = { action: "new" };
  }

  if (selected.action === "cancel") {
    rl.close();
    return;
  }

  if (selected.action === "focus") {
    const paneId = selected.session.liveAgent?.pane_id;
    rl.close();
    if (!paneId) throw new Error("running session did not include a pane id");
    output.write(`\nFocusing running ${selected.session.harness} session "${selected.session.name}".\n`);
    runHerdr(["agent", "focus", paneId]);
    return;
  }

  const harness = selected.action === "resume" ? selected.session.harness : await chooseHarness(rl, config);
  const nativeArgs = selected.action === "resume"
    ? buildResumeArguments(selected.session, target.url)
    : buildNewArguments(harness, target.sessionName, target.url);
  const previousCodexIds = selected.action === "new" && harness === "codex"
    ? await codexSessionIdsWithName(target.sessionName)
    : [];
  const launchAgentName = harness === "pi"
    ? ""
    : selected.action === "resume"
      ? agentNameForSession(`${harness}:${selected.session.id}`)
      : target.agentName;
  const tabLabel = selected.action === "resume" ? selected.session.name : target.label;
  const location = createLaunchLocation(config, tabLabel);
  rl.close();

  const { tabId, paneId } = location;
  const verb = selected.action === "resume" ? "Resuming" : "Starting";
  const nativeName = selected.action === "resume" ? selected.session.name : target.sessionName;
  output.write(`Waiting for the new pane shell...\n`);
  output.write(`${verb} ${harness} session "${nativeName}"...\n`);
  const agentTarget = await startAgent(launchAgentName, harness, paneId, nativeArgs, config);

  if (selected.action === "new") {
    const rename = harness === "codex" ? renderTemplate(config.agents.codex.renameCommand, {
      ...target,
      sessionName: target.sessionName,
      sessionId: target.sessionName,
    }).trim() : "";
    if (rename) {
      promptAgent(agentTarget, rename);
      await waitForCodexName(target.sessionName, previousCodexIds, config.timing.sessionNameTimeoutMs);
    }
    if (harness !== "pi") promptAgent(agentTarget, discussionPrompt(config, target));
  }

  output.write(`Done. ${harness} is running in ${tabId} as "${nativeName}".\n`);
}

main().catch(async (error) => {
  output.write(`\nError: ${error.message}\n`);
  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter to close.");
  rl.close();
  process.exitCode = 1;
});
