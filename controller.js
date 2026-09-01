#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), crypto = require("node:crypto");
const path = require("node:path"), readline = require("node:readline");
const readlinePromises = require("node:readline/promises"), { spawn, spawnSync } = require("node:child_process");
const { stdin: input, stdout: output } = require("node:process");
const { issuePrompt, prPrompt } = require("./prompts.js");
const {
  associatedPr, cleanupTransaction, decodePayload, handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch, withCleanupClaim,
} = require("./cleanup.js");
const {
  Lifecycle, WORKTREE_ROOT, buildCodexArgs, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, parseGitHubRemote, parseSameRepositoryTarget, parseTarget, parseWorktreeList,
  sendPipeMessage, validateReport,
} = require("./workflow.js");

const PLUGIN_ID = "pimpmuckl.codex-workflows";
const METADATA_SOURCE = "plugin:pimpmuckl.codex-workflows";
const herdr = process.env.HERDR_BIN_PATH || "herdr", gitBin = process.env.GIT_BIN_PATH || "git";
const gh = process.env.GH_BIN_PATH || "gh", codexBin = process.env.CODEX_BIN_PATH;
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || __dirname;
const CODE_ROOT = path.dirname(WORKTREE_ROOT);
const launchSteps = ["Resolve repository", "Verify GitHub target", "Create worktree", "Start Codex"];
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

function runCodex(args) {
  return codexBin ? execute(codexBin, args) : execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex", ...args]);
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

function repositoryAt(root) {
  root = git(root, ["rev-parse", "--show-toplevel"]);
  const repo = parseGitHubRemote(git(root, ["remote", "get-url", "origin"]));
  return { root: path.resolve(root), repo, repoName: repo.split("/").pop() };
}

function sourceRepository(context) {
  const cwd = context.worktree?.repo_root || context.worktree?.checkout_path || context.workspace_cwd || context.focused_pane_cwd;
  if (!cwd) throw new Error("the action did not receive a workspace checkout");
  return repositoryAt(cwd);
}

function resolveRepository(target, current, operations = {}) {
  if (target.repo === current.repo) return current;
  const exists = operations.exists || fs.existsSync;
  const identify = operations.identify || repositoryAt;
  const codeRoot = operations.codeRoot || CODE_ROOT;
  const clone = operations.clone || ((repo, root) => {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    execute(gh, ["repo", "clone", repo, root]);
  });
  const [owner, name] = target.repo.split("/");
  const familiar = path.join(codeRoot, name);
  if (exists(familiar)) {
    try {
      const repository = identify(familiar);
      if (repository.repo === target.repo) return repository;
    } catch {}
  }
  const root = path.join(codeRoot, owner, name);
  if (!exists(root)) clone(target.repo, root);
  const repository = identify(root);
  if (repository.repo !== target.repo) throw new Error(`repository path ${root} belongs to ${repository.repo}, not ${target.repo}`);
  return repository;
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
    "number,title,body,url,author,baseRefName,baseRefOid,headRefName,headRefOid"]));
}
function githubReviewPage(repository, number, headSha, page) {
  const requests = [
    ["reviewComments", `repos/${repository.repo}/pulls/${number}/comments`, "[.[] | {id,user:.user.login,body:((.body // \"\")[0:4000]),bodyOmittedCharacters:([((.body // \"\")|length)-4000,0]|max),path,line,commit_id,html_url}]"],
    ["reviews", `repos/${repository.repo}/pulls/${number}/reviews`, "[.[] | {id,user:.user.login,state,body:((.body // \"\")[0:4000]),bodyOmittedCharacters:([((.body // \"\")|length)-4000,0]|max),submitted_at,commit_id,html_url}]"],
    ["comments", `repos/${repository.repo}/issues/${number}/comments`, "[.[] | {id,user:.user.login,body:((.body // \"\")[0:4000]),bodyOmittedCharacters:([((.body // \"\")|length)-4000,0]|max),created_at,updated_at,html_url}]"],
    ["files", `repos/${repository.repo}/pulls/${number}/files`, "[.[] | {filename,status,additions,deletions,changes,previous_filename}]"],
    ["checks", `repos/${repository.repo}/commits/${headSha}/check-runs`, "[.check_runs[] | {name,status,conclusion,started_at,completed_at,html_url}]"],
    ["statuses", `repos/${repository.repo}/commits/${headSha}/statuses`, "[.[] | {context,state,description,target_url,created_at,updated_at}]"],
  ];
  return Object.fromEntries(requests.map(([name, endpoint, jq]) => [name, readJson(execute(gh,
    ["api", "--method", "GET", endpoint, "-f", "per_page=10", "-f", `page=${page}`, "--jq", jq]))]));
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

function projectTerminal(runtime, report, candidate = getAgent(runtime.identity.agentName)) {
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const paneId = runtime.worktree.root_pane.pane_id;
  let owner = null;
  try { owner = candidate && matchingSession([candidate], workspaceId, paneId); } catch {}
  if (owner) runtime.ownerSessionId = owner.agent_session.value;
  const stale = runtime.workflow === "pr" && report.status === "complete" && report["reviewed-head"].toLowerCase() !== report["current-head"].toLowerCase();
  const resultText = report.status === "complete" ? (stale ? "complete · head changed" : runtime.workflow === "issue" ? "complete · PR open" : "complete") : report.status;
  try {
    runHerdr(["workspace", "rename", workspaceId, `[${runtime.identity.shortLabel}] ${resultText}`]);
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", `workflow_state=${report.status}`,
      "--token", `workflow_controller=${report.status === "complete" ? "active" : "inactive"}`,
      "--token", `workflow_phase=${resultText}`,
      ...(runtime.ownerSessionId ? ["--token", `workflow_root_pane=${paneId}`, "--token", `workflow_session=${runtime.ownerSessionId}`] : []),
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

async function waitForShell(paneId, cwd) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const info = runHerdrJson(["pane", "process-info", "--pane", paneId])?.result?.process_info;
      if (info?.shell_pid
        && info.foreground_process_group_id === info.shell_pid
        && info.foreground_processes?.length === 1
        && info.foreground_processes[0].pid === info.shell_pid
        && (!cwd || path.resolve(info.foreground_processes[0].cwd || "").toLowerCase() === path.resolve(cwd).toLowerCase())) return;
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
  runtime.ownerSessionId = matchingSession([getAgent(runtime.identity.agentName)], runtime.worktree.workspace.workspace_id, paneId).agent_session.value;
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

function listAgents() {
  return runHerdrJson(["agent", "list"])?.result?.agents || [];
}

function projectCleanup(workspaceId, state) {
  if (!getWorkspace(workspaceId)) return;
  runHerdr([
    "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
    "--token", "workflow_controller=inactive", "--token", `workflow_cleanup=${state}`,
  ]);
}

function cleanupOps(workspaceId) {
  return {
    workspace: async (workspaceId) => getWorkspace(workspaceId),
    agents: async () => listAgents(),
    git: async (cwd, args) => git(cwd, args),
    pullRequest: async (repo, number) => readJson(execute(gh, ["pr", "view", String(number), "--repo", repo, "--json", "state,mergedAt"])),
    archive: async (sessionId) => runCodex(["archive", sessionId]),
    remove: async (workspaceId) => runHerdr(["worktree", "remove", "--workspace", workspaceId]),
    project: async (state) => projectCleanup(workspaceId, state),
    notify: async (title, body) => notify(title, body, title === "Codex workflow cleaned up" ? "done" : "request"),
    delay,
  };
}

async function handoffCleanup(runtime, repository) {
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const rootPaneId = runtime.worktree.root_pane.pane_id;
  const payload = {
    version: 1, workflow: runtime.workflow, workspaceId, rootPaneId,
    worktreePath: runtime.worktree.path, repoRoot: repository.root, repo: repository.repo,
    branch: runtime.identity.branch, sessionId: runtime.ownerSessionId,
    prNumber: associatedPr(runtime.workflow, runtime.terminal, runtime.prNumber, repository.repo),
  };
  await handoffWatcher(__filename, payload, async () => {
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", "workflow_state=complete", "--token", "workflow_controller=inactive",
      "--token", `workflow_branch=${runtime.identity.branch}`, "--token", "workflow_cleanup=waiting",
    ]);
  });
  notify("Codex workflow waiting for PR merge", "The workspace will be cleaned up after this pull request merges.");
}

async function releaseParent(runtime) {
  const paneId = runtime.worktree.root_pane.pane_id;
  const rootAgents = listAgents().filter((agent) => agent.workspace_id === runtime.worktree.workspace.workspace_id && agent.pane_id === paneId);
  if (rootAgents.length) {
    matchingOwnedSession(rootAgents, runtime.worktree.workspace.workspace_id, paneId, runtime.ownerSessionId);
    runHerdr(["agent", "prompt", runtime.identity.agentName, "/quit"]);
  }
  await waitForShell(paneId);
  const outsideCwd = path.parse(path.resolve(runtime.worktree.path)).root;
  runHerdr(["pane", "run", paneId, `cd ${outsideCwd}`]);
  await waitForShell(paneId, outsideCwd);
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
        projectTerminal(runtime, runtime.terminal, agent);
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

function progressView(workflow, launch, frame = 0) {
  const step = Math.max(0, Math.min(launchSteps.length, Number(launch.step) || 0));
  const complete = launch.status === "started" ? launchSteps.length : step;
  const width = 24, filled = Math.round((complete / launchSteps.length) * width);
  const spinner = "|/-\\"[frame % 4];
  const source = launch.repositorySource === "link" ? "full link" : "current workspace";
  const rows = launchSteps.map((label, index) => {
    const marker = index < complete ? "[x]" : launch.status === "running" && index === step ? `[${spinner}]` : "[ ]";
    return `${marker} ${label}`;
  });
  return `\x1b[2J\x1b[H${workflow === "issue" ? "Issue to pull request" : "Understand pull request"}\n`
    + `Repository: ${launch.repo} (${source})\n`
    + `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.round((complete / launchSteps.length) * 100)}%\n`
    + `${rows.join("\n")}\n`;
}

function openInputPopup(pipeName, workflow, repo, invoke = runHerdr) {
  const args = [
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "input",
    "--cwd", __dirname,
    "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`,
    "--env", `HERDR_CODEX_WORKFLOW_KIND=${workflow}`,
    "--env", `HERDR_CODEX_WORKFLOW_REPO=${repo}`,
    "--focus",
  ];
  invoke(args);
}

async function controller(workflow) {
  if (process.platform !== "win32") throw new Error("Codex Workflows supports Windows only");
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  let repository = sourceRepository(context);
  const lifecycle = new Lifecycle();
  const pipeName = makePipeName();
  let resolveInput;
  let resolveHello;
  const inputPromise = new Promise((resolve) => { resolveInput = resolve; });
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });
  const runtime = {
    workflow, lifecycle, pipeName, phase: "investigating", terminal: null,
    launch: { status: "collecting", step: 0, repo: repository.repo, repositorySource: "current" },
  };
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
      if (connection.popup && message?.type === "status") return { launch: { ...runtime.launch } };
      if (lifecycle.state !== "RUNNING") throw new Error("workflow parent is not running");
      if (workflow === "pr" && message?.type === "query-github") return { snapshot: githubSnapshot(repository, runtime.prNumber) };
      if (workflow === "pr" && message?.type === "query-review-page") {
        if (!Number.isInteger(message.page) || message.page < 1) throw new Error("review page must be a positive integer");
        return { page: githubReviewPage(repository, runtime.prNumber, runtime.headSha, message.page) };
      }
      if (workflow === "pr" && message?.type === "query-current-head") return { headSha: currentPullRequestHead(repository, runtime.prNumber) };
      const report = validateReport(workflow, message);
      if (report.type === "phase") {
        runtime.phase = report.phase;
        project(runtime, report.phase, report.blocked, report.reason);
      } else {
        if (runtime.terminal) throw new Error("terminal report was already received");
        if (workflow === "issue" && report.status === "complete") {
          const target = parseSameRepositoryTarget("pr", report["pr-url"], repository.repo), live = readJson(execute(gh, ["pr", "view", String(target.number), "--repo", repository.repo, "--json", "state,headRefOid,baseRefName,headRefName"]));
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
    openInputPopup(pipeName, workflow, repository.repo);
    await Promise.race([helloPromise, delay(30000).then(() => { throw new Error("input popup did not connect to its controller"); })]);
    const raw = await inputPromise;
    if (raw === null) return;
    runtime.launch.status = "running";
    const target = parseTarget(workflow, raw, repository.repo);
    runtime.launch.repo = target.repo;
    runtime.launch.repositorySource = target.repositorySource;
    requireGitHubAuth();
    repository = resolveRepository(target, repository);
    runtime.launch.step = 1;
    await delay(0);
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
    runtime.launch.step = 2;
    await delay(0);
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
    runtime.launch.step = 3;
    await delay(0);
    await startParent(runtime, workflow === "issue" ? issuePrompt(promptData) : prPrompt(promptData));
    lifecycle.transition("provisioned");
    runtime.launch.status = "started";
    runtime.launch.step = launchSteps.length;
    await delay(0);
    project(runtime, "investigating");
    await monitor(runtime);
    let releaseError = null;
    try { await releaseParent(runtime); } catch (error) { releaseError = error; console.error(`parent release failed: ${error.message}`); }
    if (runtime.terminal?.status === "complete") {
      try {
        if (releaseError) throw releaseError;
        await handoffCleanup(runtime, repository);
      }
      catch (error) {
        try { projectCleanup(runtime.worktree.workspace.workspace_id, "stopped"); } catch (projectError) { console.error(`cleanup metadata update failed: ${projectError.message}`); }
        notify("Codex workflow cleanup stopped", "Automatic cleanup could not be armed; the workspace and branch remain.");
        console.error(`cleanup handoff failed: ${error.message}`);
      }
    }
  } catch (error) {
    runtime.launch.status = "failed";
    runtime.launch.error = error.message;
    if (runtime.popupConnected) await delay(100);
    if (runtime.prompt) try { await stopParent(runtime); } catch (stopError) { console.error(`parent shutdown failed: ${stopError.message}`); }
    if (!["COMPLETE", "FAILED", "CANCELLED"].includes(lifecycle.state)) lifecycle.transition("fail");
    if (runtime.worktree) {
      projectTerminal(runtime, { type: "terminal", status: "failed", reason: error.message });
      try { await releaseParent(runtime); } catch (releaseError) { console.error(`parent release failed: ${releaseError.message}`); }
    } else {
      notify("Codex workflow failed", error.message);
    }
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await server.shutdown();
  }
}

async function showLaunchProgress(client, workflow) {
  let launch = { status: "running", step: 0, repo: process.env.HERDR_CODEX_WORKFLOW_REPO, repositorySource: "current" };
  for (let frame = 0; ; frame += 1) {
    let reply, failure, settled = false;
    client.request({ type: "status" }).then((value) => { reply = value; settled = true; }, (error) => { failure = error; settled = true; });
    while (!settled) {
      output.write(progressView(workflow, launch, frame));
      await delay(80);
    }
    if (failure) throw failure;
    if (!reply.ok) throw new Error(reply.error);
    launch = reply.launch;
    output.write(progressView(workflow, launch, frame));
    if (launch.status === "failed") throw new Error(launch.error || "workflow launch failed");
    if (launch.status === "started") { await delay(200); return; }
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
    output.write("Full GitHub links select their repository.\n");
    output.write("Numbers and partial links stay in this repository.\n\n");
    const value = await readPopupInput(workflow === "issue" ? "Issue URL, number, or short description: " : "Pull-request URL or number: ");
    reply = await client.request(value === null ? { type: "cancel" } : { type: "input", value });
    if (!reply.ok) throw new Error(reply.error);
    submitted = true;
    if (value !== null) await showLaunchProgress(client, workflow);
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
        description: "Report a phase or terminal result, or query PR data through the Herdr controller. Types: phase, terminal, query-github, query-review-page, query-current-head.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: { type: "object", required: ["type"], additionalProperties: true, properties: {
          type: { type: "string", enum: ["phase", "terminal", "query-github", "query-review-page", "query-current-head"] },
          phase: { type: "string" }, blocked: { type: "boolean" }, reason: { type: "string" },
          status: { type: "string", enum: ["complete", "failed", "cancelled"] }, page: { type: "integer", minimum: 1 },
        } },
      }] };
      else if (request.method === "tools/call" && request.params?.name === "workflow") {
        const message = request.params.arguments || {};
        const reply = await sendPipeMessage(pipeName, message);
        const text = message.type === "query-current-head" ? reply.headSha
          : JSON.stringify(reply.snapshot || reply.page || { acknowledged: true });
        result = { content: [{ type: "text", text }], structuredContent: reply };
      } else if (request.method === "ping") result = {};
      else throw new Error(`unsupported MCP method: ${request.method}`);
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })}\n`);
    }
  }
}

async function cleanup() {
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  if (!context.workspace_id) throw new Error("cleanup requires a current workflow workspace");
  const workspace = getWorkspace(context.workspace_id);
  const { worktree, tokens } = manualWorkspace(workspace);
  const branch = git(worktree.checkout_path, ["branch", "--show-current"]);
  const payload = {
    version: 1, workflow: tokens.workflow_kind, workspaceId: context.workspace_id,
    rootPaneId: tokens.workflow_root_pane, worktreePath: worktree.checkout_path, repoRoot: worktree.repo_root,
    repo: parseGitHubRemote(git(worktree.checkout_path, ["remote", "get-url", "origin"])),
    branch, sessionId: tokens.workflow_session, prNumber: null,
  };
  const result = await withCleanupClaim(payload, async () => {
    projectCleanup(context.workspace_id, "manual");
    return cleanupTransaction(payload, cleanupOps(context.workspace_id), false, true);
  });
  if (result.status === "removed") return notify("Codex workflow cleaned up", `Archived its Codex session and removed ${worktree.checkout_path}; branch ${branch} remains.`, "done");
  if (result.status === "missing") return;
  if (result.status === "busy") {
    notify("Codex workflow cleanup stopped", result.reason);
    throw new Error(result.reason);
  }
  projectCleanup(context.workspace_id, result.status);
  notify(result.status === "partial" ? "Codex workflow partially cleaned up" : "Codex workflow cleanup stopped", result.reason);
  throw new Error(result.reason);
}

async function watcher(encodedPayload) {
  const payload = decodePayload(encodedPayload);
  if (typeof process.send !== "function") throw new Error("cleanup watcher requires its controller IPC channel");
  const disconnected = new Promise((resolve) => process.once("disconnect", resolve));
  await new Promise((resolve, reject) => process.send({ type: "armed" }, (error) => error ? reject(error) : resolve()));
  await disconnected;
  return watch(payload, cleanupOps(payload.workspaceId));
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "issue" || mode === "pr") return controller(mode);
  if (mode === "popup") return popup();
  if (mode === "mcp") return mcp(args[0], args[1]);
  if (mode === "cleanup") return cleanup();
  if (mode === "watch") return watcher(args[0]);
  throw new Error("expected issue, pr, popup, mcp, cleanup, or watch mode");
}

module.exports = { openInputPopup, progressView, resolveRepository };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
