#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), crypto = require("node:crypto");
const path = require("node:path"), readline = require("node:readline");
const readlinePromises = require("node:readline/promises"), { spawn, spawnSync } = require("node:child_process");
const { stdin: input, stdout: output } = require("node:process");
const { issuePrompt, prPrompt } = require("./prompts.js");
const {
  Lifecycle, buildCodexArgs, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, normalizePath, parseGitHubRemote, parseTarget, parseWorktreeList,
  sendPipeMessage, validateReport,
} = require("./workflow.js");

const PLUGIN_ID = "pimpmuckl.codex-workflows";
const METADATA_SOURCE = "plugin:pimpmuckl.codex-workflows";
const WORKTREE_ROOT = "C:\\Code\\.worktrees";
const herdr = process.env.HERDR_BIN_PATH || "herdr", gitBin = process.env.GIT_BIN_PATH || "git";
const gh = process.env.GH_BIN_PATH || "gh", pluginRoot = process.env.HERDR_PLUGIN_ROOT || __dirname;
function readJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = compact(result.stderr) || compact(result.stdout) || result.error?.message || `exit ${result.status}`;
    const error = new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    error.herdrCode = readJson(detail)?.error?.code;
    throw error;
  }
  return result.stdout.trim();
}
function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function succeeds(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}
function runJson(command, args) {
  const stdout = execute(command, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} returned non-JSON output`);
  }
}
function runHerdr(args) {
  return execute(herdr, args);
}
function runHerdrJson(args) {
  return runJson(herdr, args);
}

function git(cwd, args) {
  return execute(gitBin, ["-C", cwd, ...args]);
}

function fetchPinned(repository, remoteRef) {
  const temporaryRef = `refs/codex-workflows/${crypto.randomUUID()}`;
  try {
    git(repository.root, ["fetch", "--no-tags", "origin", `+${remoteRef}:${temporaryRef}`]);
    return git(repository.root, ["rev-parse", `${temporaryRef}^{commit}`]);
  } finally {
    succeeds(gitBin, ["-C", repository.root, "update-ref", "-d", temporaryRef]);
  }
}

function notify(title, body, sound = "request") {
  try {
    runHerdr(["notification", "show", title, "--body", compact(body).slice(0, 240), "--sound", sound]);
  } catch (error) {
    console.error(error.message);
  }
}

function sourceRepository(context) {
  const cwd = context.worktree?.checkout_path || context.workspace_cwd || context.focused_pane_cwd;
  if (!cwd) throw new Error("the action did not receive a workspace checkout");
  const root = context.worktree?.repo_root || git(cwd, ["rev-parse", "--show-toplevel"]);
  const repo = parseGitHubRemote(git(root, ["remote", "get-url", "origin"]));
  return { root: path.resolve(root), repo, repoName: repo.split("/").pop() };
}

function requireGitHubAuth() {
  execute(gh, ["auth", "status", "--hostname", "github.com"]);
}

function configuredMcpNames() {
  const servers = readJson(execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex --disable apps --disable plugins mcp list --json"]), []);
  return servers.map((server) => server.name).filter(Boolean);
}

function issueBase(repository) {
  const data = readJson(execute(gh, ["repo", "view", repository.repo, "--json", "nameWithOwner,defaultBranchRef"]));
  if (!data?.defaultBranchRef?.name || String(data.nameWithOwner || "").toLowerCase() !== repository.repo) {
    throw new Error("GitHub did not return the expected repository default branch");
  }
  return {
    baseBranch: data.defaultBranchRef.name,
    baseSha: fetchPinned(repository, `refs/heads/${data.defaultBranchRef.name}`),
  };
}

function pullRequest(repository, number) {
  const data = readJson(execute(gh, [
    "pr", "view", String(number), "--repo", repository.repo,
    "--json", "number,url,baseRefName,baseRefOid,headRefOid",
  ]));
  if (!data?.headRefOid || !data?.baseRefOid || Number(data.number) !== number) {
    throw new Error("GitHub did not return exact pull-request identities");
  }
  const fetchedBase = fetchPinned(repository, `refs/heads/${data.baseRefName}`);
  if (fetchedBase.toLowerCase() !== data.baseRefOid.toLowerCase()) throw new Error(`fetched pull-request base ${fetchedBase} does not match ${data.baseRefOid}`);
  const fetched = fetchPinned(repository, `refs/pull/${number}/head`);
  if (fetched.toLowerCase() !== data.headRefOid.toLowerCase()) {
    throw new Error(`fetched pull-request head ${fetched} does not match ${data.headRefOid}`);
  }
  return {
    prNumber: number,
    prUrl: data.url,
    baseBranch: data.baseRefName,
    baseSha: data.baseRefOid,
    headSha: data.headRefOid,
  };
}

function githubSnapshot(repository, number) {
  return readJson(execute(gh, ["pr", "view", String(number), "--repo", repository.repo, "--json",
    "number,title,body,url,author,baseRefName,baseRefOid,headRefName,headRefOid,statusCheckRollup,reviews,comments,files"]));
}
function githubReviewComments(repository, number, page) {
  return readJson(execute(gh, ["api", "--method", "GET", `repos/${repository.repo}/pulls/${number}/comments`, "-f", "per_page=50", "-f", `page=${page}`]));
}
function currentPullRequestHead(repository, number) {
  const value = readJson(execute(gh, ["pr", "view", String(number), "--repo", repository.repo, "--json", "headRefOid"]));
  if (!value?.headRefOid) throw new Error("GitHub did not return the current pull-request head");
  return value.headRefOid;
}
function assertNoCollision(repository, branch, worktree) {
  const herdrWorktrees = runHerdrJson(["worktree", "list", "--cwd", repository.root])?.result?.worktrees || [];
  const reason = collisionReason({
    branch,
    path: worktree,
    branchExists: succeeds(gitBin, ["-C", repository.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
    pathExists: fs.existsSync(worktree),
    gitWorktrees: parseWorktreeList(git(repository.root, ["worktree", "list", "--porcelain"])),
    herdrWorktrees,
  });
  if (reason) throw new Error(reason);
}

function createWorktree(repository, identity, baseSha) {
  const worktree = path.join(WORKTREE_ROOT, repository.repoName, identity.directory);
  assertNoCollision(repository, identity.branch, worktree);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const result = runHerdrJson([
    "worktree", "create", "--cwd", repository.root,
    "--branch", identity.branch, "--base", baseSha, "--path", worktree,
    "--label", identity.shortLabel, "--no-focus",
  ])?.result;
  if (!result?.workspace?.workspace_id || !result?.root_pane?.pane_id || !result?.tab?.tab_id || !result?.worktree?.path) {
    throw new Error("Herdr worktree.create omitted workspace, tab, root pane, or worktree data");
  }
  return { ...result, path: worktree };
}

function phaseText(phase, blocked = false) {
  const friendly = phase === "ci-reviewers" ? "CI and reviewers" : phase.replace(/-/g, " ");
  return blocked ? `${friendly} · blocked` : friendly;
}

function project(runtime, phase, blocked = false, reason = "") {
  const text = phaseText(phase, blocked);
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const paneId = runtime.worktree.root_pane.pane_id;
  try {
    runHerdr(["workspace", "rename", workspaceId, `[${runtime.identity.shortLabel}] ${text}`]);
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", `workflow_kind=${runtime.workflow}`,
      "--token", `workflow_state=${runtime.lifecycle.state}`,
      "--token", `workflow_phase=${phase}`,
      "--token", "workflow_controller=active",
      "--token", `workflow_branch=${runtime.identity.branch}`,
    ]);
    runHerdr([
      "pane", "report-metadata", paneId, "--source", METADATA_SOURCE,
      "--display-agent", "Codex workflow", "--title", `${runtime.identity.shortLabel} parent`,
      "--state-label", `working=${text}`, "--state-label", `blocked=${compact(reason) || "needs input"}`,
      "--token", `workflow_phase=${phase}`,
    ]);
  } catch (error) {
    console.error(`metadata update failed: ${error.message}`);
  }
}

function projectTerminal(runtime, report) {
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const paneId = runtime.worktree.root_pane.pane_id;
  const stale = runtime.workflow === "pr" && report.status === "complete" && report["reviewed-head"].toLowerCase() !== report["current-head"].toLowerCase();
  const resultText = report.status === "complete" ? (stale ? "complete · head changed" : runtime.workflow === "issue" ? "complete · PR open" : "complete") : report.status;
  try {
    runHerdr(["workspace", "rename", workspaceId, `[${runtime.identity.shortLabel}] ${resultText}`]);
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", `workflow_state=${report.status}`,
      "--token", "workflow_controller=inactive",
      "--token", `workflow_phase=${resultText}`,
    ]);
    runHerdr(["pane", "rename", paneId, `${runtime.identity.shortLabel} Codex parent`]);
  } catch (error) {
    console.error(`terminal metadata update failed: ${error.message}`);
  }
  const body = report.status === "complete" ? report["pr-url"] || resultText : report.reason;
  notify(`Codex workflow ${report.status}`, body, report.status === "complete" ? "done" : "request");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForShell(paneId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const info = runHerdrJson(["pane", "process-info", "--pane", paneId])?.result?.process_info;
      if (info?.shell_pid
        && info.foreground_process_group_id === info.shell_pid
        && info.foreground_processes?.length === 1
        && info.foreground_processes[0].pid === info.shell_pid) return;
    } catch {
      // New pane shells can take a moment to appear.
    }
    await delay(100);
  }
  throw new Error(`root pane ${paneId} did not reach an available shell`);
}

async function startParent(runtime, prompt) {
  const paneId = runtime.worktree.root_pane.pane_id;
  await waitForShell(paneId);
  runHerdr([
    "agent", "start", runtime.identity.agentName, "--kind", "codex", "--pane", paneId,
    "--timeout", "300000", "--", ...buildCodexArgs(runtime.workflow, runtime.worktree.path, {
      helper: path.join(pluginRoot, "controller.js"), pipe: runtime.pipeName, name: runtime.bridgeName,
      disabled: runtime.workflow === "pr" ? configuredMcpNames() : [],
    }),
  ]);
  const child = spawn(herdr, ["agent", "prompt", runtime.identity.agentName, prompt, "--wait"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime.prompt = { child, finished: false, error: null };
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { runtime.prompt.error = error; });
  child.once("close", (code) => {
    runtime.prompt.finished = true;
    if (code !== 0) runtime.prompt.error = new Error(compact(stderr) || `agent prompt exited ${code}`);
  });
}

async function stopParent(runtime) {
  try {
    const agent = getAgent(runtime.identity.agentName);
    if (agent && !["idle", "done"].includes(agent.agent_status)) {
      runHerdr(["agent", "send-keys", runtime.identity.agentName, "ctrl+c"]);
      try { runHerdr(["agent", "wait", runtime.identity.agentName, "--until", "idle", "--until", "done", "--timeout", "30000"]); }
      catch {
        runHerdr(["agent", "send-keys", runtime.identity.agentName, "ctrl+c"]);
        try { runHerdr(["agent", "wait", runtime.identity.agentName, "--until", "idle", "--until", "done", "--timeout", "5000"]); }
        catch (error) {
          const remaining = getAgent(runtime.identity.agentName);
          if (remaining && !["idle", "done"].includes(remaining.agent_status)) throw error;
        }
      }
    }
  } finally {
    if (!runtime.prompt.finished) {
      const closed = new Promise((resolve) => runtime.prompt.child.once("close", resolve));
      runtime.prompt.child.kill(); await Promise.race([closed, delay(5000)]);
    }
  }
}

function getWorkspace(workspaceId) {
  try {
    return runHerdrJson(["workspace", "get", workspaceId])?.result?.workspace || null;
  } catch (error) {
    if (error.herdrCode === "workspace_not_found") return null;
    throw error;
  }
}

function getAgent(name) {
  try {
    return runHerdrJson(["agent", "get", name])?.result?.agent || null;
  } catch (error) {
    if (["agent_not_found", "pane_not_found"].includes(error.herdrCode)) return null;
    throw error;
  }
}

async function monitor(runtime) {
  let lastProjection = "";
  while (true) {
    if (!getWorkspace(runtime.worktree.workspace.workspace_id)) {
      runtime.terminal = { type: "terminal", status: "cancelled", reason: "workflow workspace was closed" };
    }
    const agent = getAgent(runtime.identity.agentName);
    if (runtime.terminal) {
      if (!agent || ["idle", "done"].includes(agent.agent_status)) {
        runtime.lifecycle.transition(runtime.terminal.status === "complete" ? "complete" : runtime.terminal.status === "cancelled" ? "cancel" : "fail");
        projectTerminal(runtime, runtime.terminal);
        return;
      }
    } else if (runtime.prompt?.error) {
      throw runtime.prompt.error;
    } else if (!agent || (runtime.prompt?.finished && ["idle", "done"].includes(agent.agent_status))) {
      throw new Error("Codex parent exited without a structured terminal report");
    } else {
      const key = `${runtime.phase}:${agent.agent_status}`;
      if (key !== lastProjection && agent.agent_status === "blocked") project(runtime, runtime.phase, true, "Codex needs input");
      lastProjection = key;
    }
    await delay(1000);
  }
}

function openInputPopup(context, pipeName, workflow, repo) {
  const args = [
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "input",
    "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`,
    "--env", `HERDR_CODEX_WORKFLOW_KIND=${workflow}`,
    "--env", `HERDR_CODEX_WORKFLOW_REPO=${repo}`,
  ];
  if (context.workspace_id) args.push("--workspace", context.workspace_id);
  if (context.focused_pane_id) args.push("--target-pane", context.focused_pane_id);
  args.push("--focus");
  runHerdr(args);
}

async function controller(workflow) {
  if (process.platform !== "win32") throw new Error("Codex Workflows supports Windows only");
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  const repository = sourceRepository(context);
  const lifecycle = new Lifecycle();
  const pipeName = makePipeName();
  let resolveInput;
  let resolveHello;
  const inputPromise = new Promise((resolve) => { resolveInput = resolve; });
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });
  const runtime = { workflow, repository, lifecycle, pipeName, phase: "investigating", terminal: null };
  const server = await createPipeServer(pipeName, {
    async message(message, connection) {
      if (message?.type === "hello") {
        if (lifecycle.state !== "COLLECTING" || runtime.popupConnected) throw new Error("controller is not collecting input");
        connection.popup = true;
        runtime.popupConnected = true;
        resolveHello();
        return {};
      }
      if (connection.popup && ["input", "cancel"].includes(message?.type)) {
        if (lifecycle.state !== "COLLECTING") throw new Error("input was already submitted");
        lifecycle.transition(message.type === "input" ? "submit" : "cancel");
        resolveInput(message.type === "input" ? compact(message.value) : null);
        return {};
      }
      if (lifecycle.state !== "RUNNING") throw new Error("workflow parent is not running");
      if (workflow === "pr" && message?.type === "query-github") return { snapshot: githubSnapshot(repository, runtime.prNumber) };
      if (workflow === "pr" && message?.type === "query-review-comments") {
        if (!Number.isInteger(message.page) || message.page < 1) throw new Error("review-comments page must be a positive integer");
        return { comments: githubReviewComments(repository, runtime.prNumber, message.page) };
      }
      if (workflow === "pr" && message?.type === "query-current-head") return { headSha: currentPullRequestHead(repository, runtime.prNumber) };
      const report = validateReport(workflow, message);
      if (report.type === "phase") {
        runtime.phase = report.phase;
        project(runtime, report.phase, report.blocked, report.reason);
      } else {
        if (runtime.terminal) throw new Error("terminal report was already received");
        if (workflow === "issue" && report.status === "complete") {
          const target = parseTarget("pr", report["pr-url"], repository.repo), live = readJson(execute(gh, ["pr", "view", String(target.number), "--repo", repository.repo, "--json", "state,headRefOid,baseRefName,headRefName"]));
          if (!target.url || live?.state !== "OPEN" || live.headRefOid?.toLowerCase() !== report["head-sha"].toLowerCase() || live.baseRefName !== runtime.baseBranch || live.headRefName !== runtime.identity.branch || !succeeds(gitBin, ["-C", runtime.worktree.path, "merge-base", "--is-ancestor", runtime.baseSha, report["head-sha"]])) throw new Error("terminal pull request does not connect the pinned base to the workflow branch at the reported head");
        }
        if (workflow === "pr" && report.status === "complete" && report["reviewed-head"].toLowerCase() !== runtime.headSha.toLowerCase()) throw new Error("terminal reviewed head does not match the pinned pull-request head");
        if (workflow === "pr" && report.status === "complete") report["current-head"] = currentPullRequestHead(repository, runtime.prNumber);
        runtime.terminal = report;
      }
      return {};
    },
    disconnect(connection) {
      if (connection.popup && lifecycle.state === "COLLECTING") {
        lifecycle.transition("cancel");
        resolveInput(null);
      }
    },
  });

  try {
    openInputPopup(context, pipeName, workflow, repository.repo);
    await Promise.race([helloPromise, delay(30000).then(() => { throw new Error("input popup did not connect to its controller"); })]);
    const raw = await inputPromise;
    if (raw === null) return;
    const target = parseTarget(workflow, raw, repository.repo);
    requireGitHubAuth();
    let details;
    let identity;
    if (workflow === "issue") {
      details = issueBase(repository);
      if (target.number) target.url ||= `https://github.com/${repository.repo}/issues/${target.number}`;
      identity = makeIdentity(workflow, target);
    } else {
      details = pullRequest(repository, target.number);
      identity = makeIdentity(workflow, target, details.headSha);
      runtime.prNumber = details.prNumber; runtime.headSha = details.headSha;
    }
    runtime.identity = identity; runtime.baseBranch = details.baseBranch; runtime.baseSha = details.baseSha;
    runtime.bridgeName = `herdr_workflow_${identity.agentName.slice(3)}`;
    runtime.worktree = createWorktree(repository, identity, workflow === "issue" ? details.baseSha : details.headSha);
    project(runtime, "investigating");
    const promptData = {
      repo: repository.repo,
      target,
      branch: identity.branch,
      worktree: runtime.worktree.path,
      bridgeName: runtime.bridgeName,
      ...details,
    };
    await startParent(runtime, workflow === "issue" ? issuePrompt(promptData) : prPrompt(promptData));
    lifecycle.transition("provisioned");
    project(runtime, "investigating");
    await monitor(runtime);
  } catch (error) {
    if (runtime.prompt) try { await stopParent(runtime); } catch (stopError) { console.error(`parent shutdown failed: ${stopError.message}`); }
    if (!["COMPLETE", "FAILED", "CANCELLED"].includes(lifecycle.state)) lifecycle.transition("fail");
    if (runtime.worktree) {
      projectTerminal(runtime, { type: "terminal", status: "failed", reason: error.message });
    } else {
      notify("Codex workflow failed", error.message);
    }
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

async function popup() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  const workflow = process.env.HERDR_CODEX_WORKFLOW_KIND;
  if (!pipeName || !workflow) throw new Error("popup was not launched by a workflow controller");
  const client = await connectPipe(pipeName);
  let submitted = false;
  try {
    let reply = await client.request({ type: "hello" });
    if (!reply.ok) throw new Error(reply.error);
    output.write("\x1b[2J\x1b[H");
    output.write(workflow === "issue" ? "Issue to pull request\n\n" : "Understand pull request\n\n");
    output.write(`Repository: ${process.env.HERDR_CODEX_WORKFLOW_REPO}\n`);
    const value = await readPopupInput(workflow === "issue" ? "Issue URL, number, or short description: " : "Pull-request URL or number: ");
    reply = await client.request(value === null ? { type: "cancel" } : { type: "input", value });
    if (!reply.ok) throw new Error(reply.error);
    submitted = true;
  } finally {
    if (submitted) client.socket.end();
    else client.socket.destroy();
  }
}

async function readPopupInput(promptText) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readlinePromises.createInterface({ input, output });
    const value = compact(await rl.question(promptText));
    rl.close();
    return value || null;
  }
  output.write(`${promptText}\nEnter submits. Esc cancels.\n> `);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let value = "";
    function finish(result) {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(result);
    }
    function onKey(sequence, key) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
      if (key.name === "return") return value.trim() ? finish(compact(value)) : undefined;
      if (key.name === "backspace") {
        if (value) {
          value = [...value].slice(0, -1).join("");
          output.write("\b \b");
        }
        return;
      }
      if (sequence && !key.ctrl && !key.meta && !sequence.startsWith("\x1b")) {
        value += sequence;
        output.write(sequence);
      }
    }
    input.on("keypress", onKey);
  });
}

async function mcp(pipeName, workflow) {
  if (!pipeName || !["issue", "pr"].includes(workflow)) throw new Error("MCP helper requires its controller pipe and workflow");
  const lines = readline.createInterface({ input });
  for await (const line of lines) {
    const request = readJson(line);
    if (request?.id === undefined) continue;
    try {
      let result;
      if (request.method === "initialize") result = {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "herdr-workflow", version: "0.1.0" },
      };
      else if (request.method === "tools/list") result = { tools: [{
        name: "workflow",
        description: "Report a phase or terminal result, or query PR data through the Herdr controller. Types: phase, terminal, query-github, query-review-comments, query-current-head.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: { type: "object", required: ["type"], additionalProperties: true, properties: {
          type: { type: "string", enum: ["phase", "terminal", "query-github", "query-review-comments", "query-current-head"] },
          phase: { type: "string" }, blocked: { type: "boolean" }, reason: { type: "string" },
          status: { type: "string", enum: ["complete", "failed", "cancelled"] }, page: { type: "integer", minimum: 1 },
        } },
      }] };
      else if (request.method === "tools/call" && request.params?.name === "workflow") {
        const message = request.params.arguments || {};
        const reply = await sendPipeMessage(pipeName, message);
        const text = message.type === "query-current-head" ? reply.headSha
          : JSON.stringify(reply.snapshot || reply.comments || { acknowledged: true });
        result = { content: [{ type: "text", text }], structuredContent: reply };
      } else if (request.method === "ping") result = {};
      else throw new Error(`unsupported MCP method: ${request.method}`);
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })}\n`);
    }
  }
}

function cleanup() {
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  if (!context.workspace_id) throw new Error("cleanup requires a current workflow workspace");
  const workspace = runHerdrJson(["workspace", "get", context.workspace_id])?.result?.workspace;
  const worktree = workspace?.worktree;
  const tokens = workspace?.tokens || {};
  if (!worktree?.is_linked_worktree || !["complete", "failed", "cancelled"].includes(tokens.workflow_state)) {
    throw new Error("current workspace has no terminal Codex workflow metadata");
  }
  if (tokens.workflow_controller !== "inactive") throw new Error("workflow controller is still active");
  const liveAgents = runHerdrJson(["agent", "list"])?.result?.agents || [];
  if (liveAgents.some((agent) => agent.workspace_id === context.workspace_id && !["idle", "done"].includes(agent.agent_status))) throw new Error("workflow workspace still has an active agent");
  const expectedRoot = normalizePath(path.join(WORKTREE_ROOT, parseGitHubRemote(git(worktree.checkout_path, ["remote", "get-url", "origin"])).split("/").pop()));
  const checkout = normalizePath(worktree.checkout_path);
  if (!checkout.startsWith(`${expectedRoot}${path.sep}`)) throw new Error("workflow worktree is outside the managed root");
  const branch = git(worktree.checkout_path, ["branch", "--show-current"]);
  if (!/^codex\/(?:issue|task|review-pr)-/.test(branch)) throw new Error("branch is not owned by this plugin");
  if (git(worktree.checkout_path, ["status", "--porcelain"])) throw new Error("workflow worktree has uncommitted changes");
  runHerdr(["worktree", "remove", "--workspace", context.workspace_id]);
  notify("Codex workflow cleaned up", `Removed ${worktree.checkout_path}; branch ${branch} remains.`, "done");
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "issue" || mode === "pr") return controller(mode);
  if (mode === "popup") return popup();
  if (mode === "mcp") return mcp(args[0], args[1]);
  if (mode === "cleanup") return cleanup();
  throw new Error("expected issue, pr, popup, mcp, or cleanup mode");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
