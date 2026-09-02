#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), crypto = require("node:crypto");
const path = require("node:path"), readline = require("node:readline");
const readlinePromises = require("node:readline/promises"), { spawn, spawnSync } = require("node:child_process");
const { stdin: input, stdout: output } = require("node:process");
const { issuePrompt, prPrompt, taskPrompt } = require("./prompts.js");
const {
  associatedPr, cleanupTransaction, decodePayload, handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch, withCleanupClaim,
} = require("./cleanup.js");
const {
  Lifecycle, WORKTREE_ROOT, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, parseGitHubRemote, parseTarget, parseWorktreeList,
} = require("./workflow.js");

const PLUGIN_ID = "pimpmuckl.codex-workflows";
const METADATA_SOURCE = "plugin:pimpmuckl.codex-workflows";
const herdr = process.env.HERDR_BIN_PATH || "herdr", gitBin = process.env.GIT_BIN_PATH || "git";
const gh = process.env.GH_BIN_PATH || "gh", codexBin = process.env.CODEX_BIN_PATH;
const CODE_ROOT = path.dirname(WORKTREE_ROOT);
const launchSteps = ["Resolve repository", "Prepare request", "Create worktree", "Start Codex"];
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
function preserveLines(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}
function isImplementationWorkflow(workflow) {
  return workflow !== "pr";
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

function runCanonicalCodex(args) {
  return execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex", ...args]);
}

function runCodex(args) {
  return codexBin ? execute(codexBin, args) : runCanonicalCodex(args);
}

function codexAgentStartArgs(agentName, paneId, readHelp = () => runCanonicalCodex(["--help"])) {
  const args = ["agent", "start", agentName, "--kind", "codex", "--pane", paneId];
  try {
    if (/(?:^|\s)--auto-account(?=\s|$)/m.test(readHelp())) args.push("--", "--auto-account");
  } catch {}
  return args;
}

function isAgentPromptStalled(stderr) {
  return /"code"\s*:\s*"agent_prompt_stalled"/.test(stderr);
}

function stalledPromptRecovery(status) {
  if (["idle", "done"].includes(status)) return "submit";
  if (["working", "blocked"].includes(status)) return "started";
  return "failed";
}

function stalledPromptRecoveryCommands(agentName) {
  return [
    ["agent", "send-keys", agentName, "enter"],
    ["agent", "wait", agentName, "--until", "working", "--until", "blocked", "--timeout", "5000"],
  ];
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

function canonicalRepositoryRoot(checkoutRoot, commonDirectory) {
  const commonRoot = path.resolve(checkoutRoot, commonDirectory);
  return path.basename(commonRoot) === ".git" ? path.dirname(commonRoot) : path.resolve(checkoutRoot);
}

function repositoryAt(root) {
  root = git(root, ["rev-parse", "--show-toplevel"]);
  root = canonicalRepositoryRoot(root, git(root, ["rev-parse", "--git-common-dir"]));
  const repo = parseGitHubRemote(git(root, ["remote", "get-url", "origin"]));
  return { root: path.resolve(root), repo, repoName: repo.split("/").pop() };
}

function sourceDirectory(context) {
  return context.focused_pane_cwd || context.worktree?.repo_root || context.worktree?.checkout_path || context.workspace_cwd;
}

function sourceRepository(context) {
  const cwd = sourceDirectory(context);
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

function implementationBase(repository) {
  const data = readJson(execute(gh, ["repo", "view", repository.repo, "--json", "nameWithOwner,defaultBranchRef"]));
  if (!data?.defaultBranchRef?.name || String(data.nameWithOwner || "").toLowerCase() !== repository.repo) {
    throw new Error("GitHub did not return the expected repository default branch");
  }
  return {
    baseBranch: data.defaultBranchRef.name,
    baseSha: fetchPinned(repository, `refs/heads/${data.defaultBranchRef.name}`),
  };
}

function completeGitHubTarget(target, data) {
  if (Number(data?.number) !== target.number || !data?.html_url) throw new Error("GitHub did not return the requested issue or pull request");
  return { ...target, type: data.pull_request ? "pr" : "issue", url: data.html_url };
}

function pullRequest(repository, number) {
  const data = readJson(execute(gh, [
    "pr", "view", String(number), "--repo", repository.repo,
    "--json", "number,url,baseRefName,baseRefOid,headRefOid",
  ]));
  if (!data?.headRefOid || !data?.baseRefOid || Number(data.number) !== number) {
    throw new Error("GitHub did not return exact pull-request identities");
  }
  const fetchedBase = fetchPinned(repository, data.baseRefOid);
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

function project(runtime, state = "working", reason = "") {
  const phase = state === "waiting" ? "waiting" : "working";
  const text = state === "blocked" ? "working · blocked" : phase;
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
  const resultText = report.status === "complete" ? (stale ? "complete · head changed" : isImplementationWorkflow(runtime.workflow) ? "complete · PR open" : "complete") : report.status;
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
  runHerdr(codexAgentStartArgs(runtime.identity.agentName, paneId));
  const child = spawn(herdr, ["agent", "prompt", runtime.identity.agentName, prompt, "--wait"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime.prompt = { child, finished: false, error: null };
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { runtime.prompt.error = error; });
  child.once("close", (code) => {
    if (code !== 0 && isAgentPromptStalled(stderr)) {
      try {
        const agent = getAgent(runtime.identity.agentName);
        const recovery = stalledPromptRecovery(agent?.agent_status);
        if (recovery === "submit") {
          for (const args of stalledPromptRecoveryCommands(runtime.identity.agentName)) runHerdr(args);
        }
        else if (recovery === "failed") {
          throw new Error(compact(stderr) || "agent prompt stalled outside a recoverable state");
        }
      } catch (error) {
        runtime.prompt.error = error;
      }
      runtime.prompt.finished = true;
      return;
    }
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

function waitForActivity(name, wait = runHerdrJson) {
  try {
    return wait(["agent", "wait", name, "--until", "working", "--until", "blocked", "--timeout", "1000"])?.result?.agent || null;
  } catch (error) {
    if (["timeout", "agent_not_running"].includes(error.herdrCode)) return null;
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

function implementationPullRequest(runtime, repository, matches = readJson(execute(gh, [
    "pr", "list", "--repo", repository.repo, "--head", runtime.identity.branch, "--state", "open",
    "--json", "number,url,headRefOid,baseRefName,headRefName",
  ]), [])) {
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("Codex left multiple open pull requests for the workflow branch");
  const pullRequest = matches[0];
  if (!pullRequest.headRefOid || pullRequest.baseRefName !== runtime.baseBranch || pullRequest.headRefName !== runtime.identity.branch
    || !succeeds(gitBin, ["-C", runtime.worktree.path, "merge-base", "--is-ancestor", runtime.baseSha, pullRequest.headRefOid])) {
    throw new Error("workflow pull request does not connect the pinned base to the workflow branch");
  }
  return pullRequest;
}

async function monitor(runtime, repository, operations = {}) {
  const workspace = operations.workspace || getWorkspace;
  const agentByName = operations.agent || getAgent;
  const findImplementationPullRequest = operations.implementationPullRequest || implementationPullRequest;
  const currentHead = operations.currentPullRequestHead || currentPullRequestHead;
  const updateProject = operations.project || project;
  const updateTerminal = operations.projectTerminal || projectTerminal;
  const activity = operations.activity || waitForActivity;
  const wait = operations.delay || delay;
  let lastProjection = "working", wasSettled = false;
  while (true) {
    if (!workspace(runtime.worktree.workspace.workspace_id)) {
      runtime.terminal = { type: "terminal", status: "cancelled", reason: "workflow workspace was closed" };
    }
    const agent = agentByName(runtime.identity.agentName);
    if (runtime.terminal) {
      runtime.lifecycle.transition("cancel");
      updateTerminal(runtime, runtime.terminal, agent);
      return;
    } else if (runtime.prompt?.error) {
      throw runtime.prompt.error;
    } else if (!agent) {
      throw new Error("Codex parent exited before the workflow completed");
    } else if (runtime.prompt?.finished && ["idle", "done"].includes(agent.agent_status)) {
      if (wasSettled) {
        const resumed = await activity(runtime.identity.agentName);
        if (resumed) {
          wasSettled = false;
          const projection = resumed.agent_status === "blocked" ? "blocked" : "working";
          if (projection !== lastProjection) updateProject(runtime, projection, "Codex needs input");
          lastProjection = projection;
        }
        continue;
      }
      wasSettled = true;
      if (isImplementationWorkflow(runtime.workflow)) {
        const pullRequest = findImplementationPullRequest(runtime, repository);
        if (!pullRequest) {
          updateProject(runtime, "waiting");
          lastProjection = "waiting";
          continue;
        }
        runtime.prNumber = Number(pullRequest.number);
        runtime.terminal = { type: "terminal", status: "complete", "pr-url": pullRequest.url, "head-sha": pullRequest.headRefOid };
      } else {
        runtime.terminal = { type: "terminal", status: "complete", "reviewed-head": runtime.headSha,
          "current-head": currentHead(repository, runtime.prNumber) };
      }
      runtime.lifecycle.transition("complete");
      updateTerminal(runtime, runtime.terminal, agent);
      return;
    } else {
      wasSettled = false;
      const projection = agent.agent_status === "blocked" ? "blocked" : "working";
      if (projection !== lastProjection) updateProject(runtime, projection, "Codex needs input");
      lastProjection = projection;
    }
    await wait(1000);
  }
}

function progressView(launch, frame = 0) {
  const step = Math.max(0, Math.min(launchSteps.length, Number(launch.step) || 0));
  const complete = launch.status === "started" ? launchSteps.length : step;
  const width = 20, filled = Math.round((complete / launchSteps.length) * width);
  const spinner = "|/-\\"[frame % 4];
  const source = launch.repositorySource === "link" ? "full link" : "current workspace";
  const checkpoint = launch.status === "started" ? "Codex started" : launchSteps[Math.min(step, launchSteps.length - 1)];
  return `\x1b[2J\x1b[H${launch.repo} (${source})\n`
    + `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.round((complete / launchSteps.length) * 100)}% ${spinner} ${checkpoint}\n`;
}

function openInputPopup(pipeName, mode = "github", invoke = runHerdr) {
  const args = [
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "input",
    "--cwd", __dirname,
    "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`,
    "--env", `HERDR_CODEX_WORKFLOW_MODE=${mode}`,
    "--focus",
  ];
  invoke(args);
}

function openProgressPane(pipeName, context, open = runHerdrJson, resize = runHerdr) {
  if (!context.focused_pane_id) throw new Error("the action did not receive a focused pane");
  open([
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "progress",
    "--placement", "split", "--target-pane", context.focused_pane_id, "--direction", "down",
    "--cwd", __dirname, "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`, "--no-focus",
  ]);
  resize(["pane", "resize", "--pane", context.focused_pane_id, "--direction", "down", "--amount", "0.4"]);
}

function controllerProtocol(runtime, lifecycle, resolveHello, resolveInput, resolveProgress = () => {}) {
  return {
    async message(message, connection) {
      if (message?.type === "hello" && message.role === "input") {
        if (lifecycle.state !== "COLLECTING" || runtime.inputConnected) throw new Error("controller is not collecting input");
        connection.role = "input";
        runtime.inputConnected = true;
        resolveHello();
        return {};
      }
      if (message?.type === "hello" && message.role === "progress") {
        connection.role = "progress";
        resolveProgress();
        return {};
      }
      if (connection.role === "input" && ["input", "cancel"].includes(message?.type)) {
        if (lifecycle.state !== "COLLECTING") throw new Error("input was already submitted");
        lifecycle.transition(message.type === "input" ? "submit" : "cancel");
        resolveInput(message.type === "input" ? (runtime.workflow === "task"
          ? { request: preserveLines(message.request) }
          : { target: compact(message.target), instructions: preserveLines(message.instructions) }) : null);
        return {};
      }
      if (connection.role === "progress" && message?.type === "status") return { launch: { ...runtime.launch } };
      throw new Error("unsupported workflow message");
    },
    disconnect(connection) {
      if (connection.role === "input" && lifecycle.state === "COLLECTING") {
        lifecycle.transition("cancel");
        resolveInput(null);
      }
    },
  };
}

async function controller(mode = "github") {
  if (process.platform !== "win32") throw new Error("Codex Workflows supports Windows only");
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  let repository = sourceRepository(context);
  const lifecycle = new Lifecycle();
  const pipeName = makePipeName();
  let resolveInput;
  let resolveHello;
  let resolveProgress;
  const inputPromise = new Promise((resolve) => { resolveInput = resolve; });
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });
  const progressPromise = new Promise((resolve) => { resolveProgress = resolve; });
  const runtime = {
    workflow: mode === "task" ? "task" : null, lifecycle, terminal: null,
    launch: { status: "collecting", step: 0, repo: repository.repo, repositorySource: "current" },
  };
  const server = await createPipeServer(pipeName, controllerProtocol(runtime, lifecycle, resolveHello, resolveInput, resolveProgress));

  try {
    openInputPopup(pipeName, mode);
    await Promise.race([helloPromise, delay(30000).then(() => { throw new Error("input popup did not connect to its controller"); })]);
    const submission = await inputPromise;
    if (submission === null) return;
    runtime.launch.status = "running";
    let target;
    if (runtime.workflow !== "task") {
      target = parseTarget(submission.target, repository.repo);
      runtime.launch.repo = target.repo;
      runtime.launch.repositorySource = target.repositorySource;
    }
    openProgressPane(pipeName, context);
    await Promise.race([progressPromise, delay(30000).then(() => { throw new Error("progress pane did not connect to its controller"); })]);
    await delay(0);
    requireGitHubAuth();
    if (runtime.workflow !== "task") repository = resolveRepository(target, repository);
    runtime.launch.step = 1;
    await delay(0);
    if (runtime.workflow !== "task") {
      target = completeGitHubTarget(target, readJson(execute(gh, ["api", `repos/${repository.repo}/issues/${target.number}`])));
      runtime.workflow = target.type;
    }
    let details;
    let identity;
    if (isImplementationWorkflow(runtime.workflow)) {
      details = implementationBase(repository);
      identity = makeIdentity(runtime.workflow, target);
    } else {
      details = pullRequest(repository, target.number);
      identity = makeIdentity(runtime.workflow, target, details.headSha);
      runtime.prNumber = details.prNumber; runtime.headSha = details.headSha;
    }
    runtime.identity = identity; runtime.baseBranch = details.baseBranch; runtime.baseSha = details.baseSha;
    runtime.launch.step = 2;
    await delay(0);
    runtime.worktree = createWorktree(repository, identity, isImplementationWorkflow(runtime.workflow) ? details.baseSha : details.headSha);
    project(runtime);
    const promptData = {
      repo: repository.repo,
      target,
      branch: identity.branch,
      worktree: runtime.worktree.path,
      instructions: submission.instructions,
      request: submission.request,
      ...details,
    };
    runtime.launch.step = 3;
    await delay(0);
    const prompt = runtime.workflow === "task" ? taskPrompt(promptData) : runtime.workflow === "issue" ? issuePrompt(promptData) : prPrompt(promptData);
    await startParent(runtime, prompt);
    lifecycle.transition("provisioned");
    runtime.launch.status = "started";
    runtime.launch.step = launchSteps.length;
    await delay(0);
    project(runtime);
    await monitor(runtime, repository);
    let releaseError = null;
    try { await releaseParent(runtime); } catch (error) { releaseError = error; console.error(`parent release failed: ${error.message}`); }
    if (runtime.terminal?.status === "complete" && releaseError) {
      try { projectCleanup(runtime.worktree.workspace.workspace_id, "stopped"); }
      catch (error) { console.error(`cleanup metadata update failed: ${error.message}`); }
      notify("Codex workflow release failed", "The workspace remains. Close any active Codex agent before cleanup.");
    } else if (runtime.terminal?.status === "complete") {
      try {
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
    if (runtime.inputConnected) await delay(100);
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

async function showLaunchProgress(client) {
  let reply = await client.request({ type: "hello", role: "progress" });
  if (!reply.ok) throw new Error(reply.error);
  let launch = { status: "running", step: 0, repo: "Starting workflow", repositorySource: "current" };
  for (let frame = 0; ; frame += 1) {
    let failure, settled = false;
    reply = null;
    client.request({ type: "status" }).then((value) => { reply = value; settled = true; }, (error) => { failure = error; settled = true; });
    while (!settled) {
      output.write(progressView(launch, frame));
      await delay(80);
    }
    if (failure) throw failure;
    if (!reply.ok) throw new Error(reply.error);
    launch = reply.launch;
    output.write(progressView(launch, frame));
    if (launch.status === "failed") throw new Error(launch.error || "workflow launch failed");
    if (launch.status === "started") { await delay(200); return; }
    await delay(80);
  }
}

async function popup() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  if (!pipeName) throw new Error("popup was not launched by a workflow controller");
  const client = await connectPipe(pipeName);
  try {
    let reply = await client.request({ type: "hello", role: "input" });
    if (!reply.ok) throw new Error(reply.error);
    const value = await readPopupInput(process.env.HERDR_CODEX_WORKFLOW_MODE);
    reply = await client.request(value === null ? { type: "cancel" } : { type: "input", ...value });
    if (!reply.ok) throw new Error(reply.error);
  } finally {
    client.socket.end();
  }
}

async function progress() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  if (!pipeName) throw new Error("progress pane was not launched by a workflow controller");
  const client = await connectPipe(pipeName);
  try { await showLaunchProgress(client); }
  finally { client.socket.end(); }
}

function popupInputView(state, width = output.columns || 80, height = output.rows || 10) {
  const task = state.mode === "task";
  const inputIndex = task ? 0 : 1;
  const instructionWidth = Math.max(1, width - 3);
  const wrapped = state.values[inputIndex].split("\n").flatMap((line) => {
    const chars = [...line], lines = [];
    do lines.push(chars.splice(0, instructionWidth).join("")); while (chars.length);
    return lines;
  });
  if (task) {
    const rows = ["Describe the feature or fix:", ...wrapped.slice(-Math.max(1, height - 1)).map((line) => `  ${line}`)];
    return `\x1b[2J\x1b[H${rows.join("\n")}\x1b[${rows.length};${[...rows.at(-1)].length + 1}H`;
  }
  const targetPrefix = `${state.active === 0 ? ">" : " "} Paste issue or PR: `;
  const target = targetPrefix + [...state.values[0]].slice(-Math.max(1, width - targetPrefix.length - 1)).join("");
  const instructions = wrapped.slice(-Math.max(1, height - 3));
  const rows = [target, "─".repeat(Math.max(1, width - 1)), `${state.active === 1 ? ">" : " "} Custom instructions:`, ...instructions.map((line) => `  ${line}`)];
  const cursorRow = state.active === 0 ? 1 : rows.length;
  return `\x1b[2J\x1b[H${rows.join("\n")}\x1b[${cursorRow};${[...rows[cursorRow - 1]].length + 1}H`;
}

function popupInputKey(state, sequence, key) {
  sequence ??= key.sequence;
  if (key.name === "escape" || (key.ctrl && key.name === "c") || ["\x1b[27u", "\x1b[99;5u"].includes(sequence)) return "cancel";
  if (["return", "enter"].includes(key.name) || sequence === "\x1b[13;2u") {
    if ((state.mode === "task" || state.active === 1) && (key.shift || sequence === "\x1b[13;2u")) { state.values[state.active] += "\n"; return "render"; }
    return state.values[0].trim() ? "submit" : null;
  }
  if (state.mode !== "task" && key.name === "tab") state.active = 1 - state.active;
  else if (state.mode !== "task" && ["right", "down"].includes(key.name)) state.active = 1;
  else if (state.mode !== "task" && ["left", "up"].includes(key.name)) state.active = 0;
  else if (key.name === "backspace") state.values[state.active] = [...state.values[state.active]].slice(0, -1).join("");
  else if (sequence && !key.ctrl && !key.meta && !sequence.startsWith("\x1b")) state.values[state.active] += sequence.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  else return null;
  return "render";
}

async function readPopupInput(mode = "github") {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readlinePromises.createInterface({ input, output });
    if (mode === "task") {
      const request = preserveLines(await rl.question("Describe the feature or fix: "));
      rl.close();
      return request ? { request } : null;
    }
    const target = compact(await rl.question("Paste issue or PR: "));
    const instructions = target ? compact(await rl.question("Custom instructions (optional): ")) : "";
    rl.close();
    return target ? { target, instructions } : null;
  }
  const state = { mode, active: 0, values: ["", ""] };
  output.write(`\x1b[>1u${popupInputView(state)}`);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    function finish(result) {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(result);
    }
    function onKey(sequence, key) {
      const action = popupInputKey(state, sequence, key);
      if (action === "cancel") return finish(null);
      if (action === "submit") return finish(mode === "task"
        ? { request: preserveLines(state.values[0]) }
        : { target: compact(state.values[0]), instructions: preserveLines(state.values[1]) });
      if (action === "render") output.write(popupInputView(state));
    }
    input.on("keypress", onKey);
  });
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
  if (mode === "start") return controller(args[0]);
  if (mode === "popup") return popup();
  if (mode === "progress") return progress();
  if (mode === "cleanup") return cleanup();
  if (mode === "watch") return watcher(args[0]);
  throw new Error("expected start, popup, progress, cleanup, or watch mode");
}

module.exports = { canonicalRepositoryRoot, codexAgentStartArgs, completeGitHubTarget, controllerProtocol, openInputPopup, openProgressPane,
  implementationPullRequest, isAgentPromptStalled, monitor, popupInputKey, popupInputView, progressView, resolveRepository, sourceDirectory, stalledPromptRecovery, stalledPromptRecoveryCommands,
  waitForActivity };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
