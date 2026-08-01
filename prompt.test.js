"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { agentNameForSession } = require("./launcher.js");

async function setupHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-start-flow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, "herdr-args.jsonl");
  const fakeHerdr = path.join(root, "herdr-fake.js");
  await fs.writeFile(
    fakeHerdr,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
function incrementCounter(name) {
  const file = process.env.FAKE_HERDR_STATE_DIR + "/" + name;
  let count = 0;
  try { count = Number(fs.readFileSync(file, "utf8")); } catch {}
  fs.writeFileSync(file, String(count + 1));
  return count + 1;
}
if (args[0] === "workspace" && args[1] === "list") {
  console.log(JSON.stringify({ id: "workspaces", result: { workspaces: [
    {
      workspace_id: "w-main",
      label: "herdr",
      worktree: {
        checkout_path: process.env.FAKE_PROJECT_CWD,
        repo_root: process.env.FAKE_PROJECT_CWD,
        repo_name: "herdr",
        is_linked_worktree: false,
      },
    },
    { workspace_id: "w1", label: "other-project" },
  ] } }));
} else if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({ id: "list", result: { agents: JSON.parse(process.env.FAKE_AGENTS_JSON || "[]") } }));
} else if (args[0] === "agent" && args[1] === "start") {
  if (process.env.FAKE_AGENT_BUSY_ONCE === "1" && incrementCounter("agent-start") === 1) {
    console.error(JSON.stringify({ error: { code: "agent_pane_busy", message: "pane is not an available shell" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ id: "start", result: { type: "ok" } }));
  }
} else if (args[0] === "agent" && args[1] === "prompt" && args[3]?.startsWith("/rename ")) {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.appendFileSync(
    process.env.CODEX_HOME + "/session_index.jsonl",
    JSON.stringify({ id: "codex-new-id", thread_name: args[3].slice(8) }) + "\\n",
  );
  console.log(JSON.stringify({ id: "prompt", result: { type: "ok" } }));
} else if (args[0] === "pane" && args[1] === "process-info") {
  const startupBusy = process.env.FAKE_SHELL_BUSY_ONCE === "1" && incrementCounter("process-info") === 1;
  console.log(JSON.stringify({
    id: "process-info",
    result: { process_info: {
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: startupBusy ? [{ pid: 100 }, { pid: 200 }] : [{ pid: 100 }],
    } },
  }));
} else if (args[0] === "tab" && args[1] === "create") {
  const workspaceIndex = args.indexOf("--workspace");
  const workspace = workspaceIndex === -1 ? "w1" : args[workspaceIndex + 1];
  console.log(JSON.stringify({ id: "tab", result: { tab: { tab_id: workspace + ":t2" }, root_pane: { pane_id: workspace + ":p2" } } }));
} else {
  console.log(JSON.stringify({ id: "ok", result: { type: "ok" } }));
}
`,
  );
  await fs.chmod(fakeHerdr, 0o755);
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");
  const cwd = path.join(root, "other-project");
  const projectCwd = path.join(root, "herdr");
  await Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(cwd, { recursive: true }),
    fs.mkdir(projectCwd, { recursive: true }),
  ]);
  return { root, log, fakeHerdr, configDir, stateDir, cwd, projectCwd };
}

async function runPrompt(setup, stdin, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "prompt.js")], {
      cwd: __dirname,
      env: {
        ...process.env,
        HERDR_BIN_PATH: setup.fakeHerdr,
        HERDR_PLUGIN_ROOT: __dirname,
        HERDR_PLUGIN_CONFIG_DIR: setup.configDir,
        HERDR_PLUGIN_STATE_DIR: setup.stateDir,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: setup.cwd }),
        FAKE_HERDR_LOG: setup.log,
        FAKE_HERDR_STATE_DIR: setup.root,
        FAKE_PROJECT_CWD: setup.projectCwd,
        PI_CODING_AGENT_DIR: path.join(setup.root, "pi"),
        CODEX_HOME: path.join(setup.root, "codex"),
        CLAUDE_CONFIG_DIR: path.join(setup.root, "claude"),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const answers = stdin.split("\n");
    let index = 0;
    const sendNext = () => {
      if (index >= answers.length - 1) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${answers[index++]}\n`);
      setTimeout(sendNext, 100);
    };
    sendNext();
  });
}

async function readCalls(log) {
  const content = await fs.readFile(log, "utf8");
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("reports no match and creates named Pi context without submitting a prompt", async (t) => {
  const setup = await setupHarness(t);
  const url = "https://github.com/herdrdev/herdr/issues/42";
  const result = await runPrompt(setup, `${url}\npi\n`);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No named session found/);
  const calls = await readCalls(setup.log);
  assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "split"), false);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", `pi --name issue-42 --gh-context-url ${url}`,
  ]);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
});

test("waits for a shell-only foreground job before launching Pi normally", async (t) => {
  const setup = await setupHarness(t);
  const result = await runPrompt(setup, "#44\npi\n", {
    FAKE_SHELL_BUSY_ONCE: "1",
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const calls = await readCalls(setup.log);
  assert.equal(calls.filter((args) => args[0] === "pane" && args[1] === "process-info").length, 2);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", "pi --name 44",
  ]);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
});

test("names Codex before sending the GitHub prompt", async (t) => {
  const setup = await setupHarness(t);
  const result = await runPrompt(setup, "#43\ncodex\n");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const calls = await readCalls(setup.log);
  const prompts = calls.filter((args) => args[0] === "agent" && args[1] === "prompt");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0], ["agent", "prompt", agentNameForSession("43"), "/rename 43"]);
  assert.equal(prompts[1][3].includes("#43"), true);
});

test("shows and resumes one exact named Pi session with launch context", async (t) => {
  const setup = await setupHarness(t);
  const url = "https://github.com/herdrdev/herdr/issues/42";
  const sessionFile = path.join(setup.root, "pi", "sessions", "work", "saved.jsonl");
  await writeJsonl(sessionFile, [
    { type: "session", id: "pi-saved", cwd: setup.cwd },
    { type: "session_info", name: "issue-42" },
  ]);

  const result = await runPrompt(setup, `${url}\n\n`);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Found 1 named session match:/);
  assert.match(result.stdout, /session name: issue-42/);
  const calls = await readCalls(setup.log);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", `pi --session ${sessionFile} --gh-context-url ${url}`,
  ]);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
});

test("finds a prefixed Pi session when searching by bare number", async (t) => {
  const setup = await setupHarness(t);
  const sessionFile = path.join(setup.root, "pi", "sessions", "work", "saved.jsonl");
  await writeJsonl(sessionFile, [
    { type: "session", id: "pi-pr", cwd: setup.cwd },
    { type: "session_info", name: "pr-1823" },
  ]);

  const result = await runPrompt(setup, "1823\n\n");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Found 1 named session match:/);
  assert.match(result.stdout, /session name: pr-1823/);
  const calls = await readCalls(setup.log);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", `pi --session ${sessionFile}`,
  ]);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
});

test("focuses a running native session instead of resuming it", async (t) => {
  const setup = await setupHarness(t);
  const sessionFile = path.join(setup.root, "pi", "sessions", "work", "saved.jsonl");
  await writeJsonl(sessionFile, [
    { type: "session", id: "pi-saved", cwd: setup.cwd },
    { type: "session_info", name: "running-work" },
  ]);
  const agents = [{
    agent: "pi",
    pane_id: "w9:p4",
    agent_session: { agent: "pi", kind: "path", value: sessionFile },
  }];

  const result = await runPrompt(setup, "running-work\n\n", {
    FAKE_AGENTS_JSON: JSON.stringify(agents),
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RUNNING/);
  const calls = await readCalls(setup.log);
  assert.deepEqual(calls.find((args) => args[0] === "agent" && args[1] === "focus"), [
    "agent", "focus", "w9:p4",
  ]);
  assert.equal(calls.some((args) => args[0] === "tab" && args[1] === "create"), false);
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
  assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "run"), false);
});

test("shows multiple harness matches and resumes the selected one", async (t) => {
  const setup = await setupHarness(t);
  const otherCwd = path.join(setup.root, "other");
  await fs.mkdir(otherCwd, { recursive: true });
  const piFile = path.join(setup.root, "pi", "sessions", "work", "saved.jsonl");
  await writeJsonl(piFile, [
    { type: "session", id: "pi-saved", cwd: setup.cwd },
    { type: "session_info", name: "shared-name" },
  ]);
  await writeJsonl(path.join(setup.root, "claude", "projects", "other", "claude-id.jsonl"), [
    { type: "user", sessionId: "claude-id", cwd: otherCwd },
    { type: "custom-title", customTitle: "shared-name", sessionId: "claude-id" },
  ]);

  const result = await runPrompt(setup, "shared-name\n2\n");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Found 2 named session matches:/);
  const calls = await readCalls(setup.log);
  assert.deepEqual(calls.find((args) => args[0] === "agent" && args[1] === "start").slice(3), [
    "--kind", "claude", "--pane", "w-main:p2", "--timeout", "30000", "--", "--resume", "claude-id",
  ]);
});

test("resumes a session with a removed cwd in the main Herdr workspace", async (t) => {
  const setup = await setupHarness(t);
  const sessionFile = path.join(setup.root, "pi", "sessions", "removed", "saved.jsonl");
  await writeJsonl(sessionFile, [
    { type: "session", id: "pi-removed", cwd: path.join(setup.root, "removed-worktree") },
    { type: "session_info", name: "removed-session" },
  ]);

  const result = await runPrompt(setup, "removed-session\n\n");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /main herdr workspace/);
  const calls = await readCalls(setup.log);
  assert.deepEqual(calls.find((args) => args[0] === "tab" && args[1] === "create"), [
    "tab", "create", "--workspace", "w-main", "--label", "removed-session",
    "--cwd", setup.projectCwd, "--focus",
  ]);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", `pi --session ${sessionFile}`,
  ]);
});

test("resumes a worktree session from the main Herdr checkout", async (t) => {
  const setup = await setupHarness(t);
  const child = path.join(setup.root, "worktrees", "feature");
  await fs.mkdir(child, { recursive: true });
  const sessionFile = path.join(setup.root, "pi", "sessions", "worktree", "saved.jsonl");
  await writeJsonl(sessionFile, [
    { type: "session", id: "pi-worktree", cwd: child },
    { type: "session_info", name: "worktree-session" },
  ]);

  const result = await runPrompt(setup, "worktree-session\n\n");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const calls = await readCalls(setup.log);
  assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "open"), false);
  assert.deepEqual(calls.find((args) => args[0] === "tab" && args[1] === "create"), [
    "tab", "create", "--workspace", "w-main", "--label", "worktree-session",
    "--cwd", setup.projectCwd, "--focus",
  ]);
  assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "run"), [
    "pane", "run", "w-main:p2", `pi --session ${sessionFile}`,
  ]);
});
