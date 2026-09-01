"use strict";

const path = require("node:path");
const crypto = require("node:crypto"), net = require("node:net");
const { spawn } = require("node:child_process");
const { WORKTREE_ROOT, normalizePath, parseGitHubRemote, parseSameRepositoryTarget, parseWorktreeList } = require("./workflow.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set(["complete", "failed", "cancelled"]);

class CleanupStop extends Error {}

function safeReason(error, fallback) {
  return error instanceof CleanupStop ? error.message : fallback;
}

function validatePayload(value) {
  if (!value || value.version !== 1 || !["issue", "pr"].includes(value.workflow)
    || !value.workspaceId || !value.rootPaneId || !value.worktreePath || !value.repoRoot
    || !/^[^/\s]+\/[^/\s]+$/.test(value.repo) || !/^codex\/(?:issue|task|review-pr)-/.test(value.branch) || !UUID.test(value.sessionId)
    || (value.prNumber !== null && (!Number.isSafeInteger(value.prNumber) || value.prNumber < 1))) {
    throw new Error("invalid cleanup watcher payload");
  }
  return Object.freeze({ ...value, repo: value.repo.toLowerCase() });
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(validatePayload(value))).toString("base64url");
}

function decodePayload(value) {
  try { return validatePayload(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { throw new Error("invalid cleanup watcher payload"); }
}

function associatedPr(workflow, report, originalNumber, repo) {
  if (workflow === "pr") {
    if (!Number.isSafeInteger(originalNumber) || originalNumber < 1) throw new Error("pull-request number is missing");
    return originalNumber;
  }
  return parseSameRepositoryTarget("pr", report?.["pr-url"], repo).number;
}

function matchingSession(agents, workspaceId, rootPaneId) {
  const matches = agents.filter((agent) => agent.workspace_id === workspaceId
    && (!rootPaneId || agent.pane_id === rootPaneId)
    && agent.agent_session?.source === "herdr:codex"
    && agent.agent_session.kind === "id"
    && UUID.test(agent.agent_session.value));
  if (matches.length !== 1) throw new CleanupStop(`expected one owning Codex session; found ${matches.length}`);
  if (!['idle', 'done'].includes(matches[0].agent_status)) throw new CleanupStop("owning Codex session is still active");
  return matches[0];
}

function matchingOwnedSession(agents, workspaceId, rootPaneId, sessionId) {
  const agent = matchingSession(agents, workspaceId, rootPaneId);
  if (!UUID.test(sessionId) || agent.agent_session.value.toLowerCase() !== sessionId.toLowerCase()) throw new CleanupStop("owning Codex session changed");
  return agent;
}

function manualWorkspace(workspace) {
  const worktree = workspace?.worktree, tokens = workspace?.tokens || {};
  if (!worktree?.is_linked_worktree || !TERMINAL_STATES.has(tokens.workflow_state)
    || !["issue", "pr"].includes(tokens.workflow_kind) || !tokens.workflow_root_pane
    || !UUID.test(tokens.workflow_session)) throw new CleanupStop("current workspace has no terminal Codex workflow metadata");
  if (tokens.workflow_controller !== "inactive") throw new CleanupStop("workflow controller is still active");
  return { worktree, tokens };
}

function classifyPullRequest(value) {
  if (value?.state === "OPEN" && !value.mergedAt) return "open";
  if (value?.state === "MERGED" && value.mergedAt) return "merged";
  if (value?.state === "CLOSED" && !value.mergedAt) return "closed";
  return "retry";
}

function assertLocalIdentity(payload, snapshot, automatic, requireSession = true) {
  const workspace = snapshot.workspace;
  if (!workspace) return false;
  const worktree = workspace.worktree, tokens = workspace.tokens || {};
  if (workspace.workspace_id !== payload.workspaceId || !worktree?.is_linked_worktree
    || normalizePath(worktree.checkout_path) !== normalizePath(payload.worktreePath)
    || normalizePath(worktree.repo_root) !== normalizePath(payload.repoRoot)) throw new CleanupStop("workspace identity changed");
  if (!TERMINAL_STATES.has(tokens.workflow_state) || tokens.workflow_kind !== payload.workflow || tokens.workflow_controller !== "inactive"
    || tokens.workflow_branch !== payload.branch || tokens.workflow_root_pane !== payload.rootPaneId
    || String(tokens.workflow_session || "").toLowerCase() !== payload.sessionId.toLowerCase()
    || (automatic && (tokens.workflow_state !== "complete" || tokens.workflow_cleanup !== "waiting"))) {
    throw new CleanupStop("workflow cleanup metadata changed");
  }
  if (snapshot.agents.some((agent) => agent.workspace_id === payload.workspaceId && agent.pane_id === payload.rootPaneId))
    throw new CleanupStop(requireSession ? "root pane agent is still active or changed" : "root pane agent changed after session archive");
  if (snapshot.agents.some((agent) => agent.workspace_id === payload.workspaceId
    && agent.pane_id !== payload.rootPaneId && !["idle", "done"].includes(agent.agent_status))) {
    throw new CleanupStop("workflow workspace has an active sibling agent");
  }
  const repoName = payload.repo.split("/")[1];
  const expectedRoot = normalizePath(path.join(WORKTREE_ROOT, repoName));
  if (!normalizePath(payload.worktreePath).startsWith(`${expectedRoot}${path.sep}`)) throw new CleanupStop("workflow worktree is outside the managed root");
  if (snapshot.repo !== payload.repo || snapshot.branch !== payload.branch || snapshot.status) throw new CleanupStop(snapshot.status ? "workflow worktree has uncommitted changes" : "Git identity changed");
  const mapping = parseWorktreeList(snapshot.worktrees).filter((item) => normalizePath(item.path) === normalizePath(payload.worktreePath));
  if (mapping.length !== 1 || mapping[0].branch !== payload.branch) throw new CleanupStop("Git worktree mapping changed");
  return true;
}

async function snapshot(payload, ops) {
  const workspace = await ops.workspace(payload.workspaceId);
  if (!workspace) return { workspace: null };
  return {
    workspace,
    repo: parseGitHubRemote(await ops.git(payload.worktreePath, ["remote", "get-url", "origin"])),
    branch: await ops.git(payload.worktreePath, ["branch", "--show-current"]),
    status: await ops.git(payload.worktreePath, ["status", "--porcelain"]),
    worktrees: await ops.git(payload.repoRoot, ["worktree", "list", "--porcelain"]),
    agents: await ops.agents(),
  };
}

async function preflight(payload, ops, automatic = true) {
  payload = validatePayload(payload);
  return assertLocalIdentity(payload, await snapshot(payload, ops), automatic);
}

async function withCleanupClaim(payload, callback) {
  payload = validatePayload(payload);
  const key = crypto.createHash("sha256").update(`${payload.workspaceId}\0${normalizePath(payload.worktreePath)}`).digest("hex").slice(0, 32);
  const server = net.createServer((socket) => socket.destroy());
  server.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(`\\\\.\\pipe\\herdr-codex-cleanup-${key}`, resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") return { status: "busy", reason: "Another cleanup transaction is already running." };
    return { status: "stopped", reason: "Cleanup ownership could not be established; the workspace was retained." };
  }
  try { return await callback(); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function cleanupTransaction(payload, ops, automatic = true, claimed = false) {
  payload = validatePayload(payload);
  if (!claimed) return withCleanupClaim(payload, () => cleanupTransaction(payload, ops, automatic, true));
  if (automatic && payload.prNumber === null) return { status: "stopped", reason: "cleanup watcher has no pull request" };
  if (automatic) {
    try {
      if (classifyPullRequest(await ops.pullRequest(payload.repo, payload.prNumber)) !== "merged") return { status: "retry" };
    } catch { return { status: "retry" }; }
  }
  try {
    if (!await preflight(payload, ops, automatic)) return { status: "missing" };
  } catch (error) {
    return { status: "stopped", reason: safeReason(error, "Cleanup preflight failed; the workspace was retained.") };
  }
  try {
    await ops.archive(payload.sessionId);
  } catch {
    return { status: "stopped", reason: "Codex session archive failed; the worktree was not removed." };
  }
  try {
    const after = await snapshot(payload, ops);
    if (!assertLocalIdentity(payload, after, automatic, false)) throw new CleanupStop("workspace disappeared after session archive");
  } catch (error) {
    return { status: "partial", reason: safeReason(error, "Post-archive validation failed; the worktree was retained.") };
  }
  try { await ops.remove(payload.workspaceId); }
  catch { return { status: "partial", reason: "Herdr could not remove the worktree after session archive; manual inspection is required." }; }
  return { status: "removed" };
}

async function handoffWatcher(controller, payload, authorize, options = {}) {
  payload = validatePayload(payload);
  if (payload.prNumber === null) throw new Error("cleanup watcher has no pull request");
  const child = (options.spawn || spawn)(process.execPath, [path.resolve(controller), "watch", encodePayload(payload)], {
    shell: false, detached: true, windowsHide: true, cwd: path.parse(path.resolve(payload.worktreePath)).root,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cleanup watcher did not arm")), options.timeout || 10000);
      const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
      child.once("message", finish((message) => message?.type === "armed" ? resolve() : reject(new Error("cleanup watcher sent an invalid acknowledgement"))));
      child.once("error", finish(reject));
      child.once("exit", finish((code) => reject(new Error(`cleanup watcher exited before arming (${code})`))));
    });
    await authorize();
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

async function watch(payload, ops, interval = 60000) {
  payload = validatePayload(payload);
  if (payload.prNumber === null) throw new Error("cleanup watcher has no pull request");
  try {
    if (!await preflight(payload, ops, true)) return "superseded";
  } catch (error) {
    await ops.project("stopped"); await ops.notify("Codex workflow cleanup stopped", safeReason(error, "Cleanup preflight failed; the workspace was retained."));
    return "stopped";
  }
  while (true) {
    try {
      const workspace = await ops.workspace(payload.workspaceId);
      if (!workspace || workspace.tokens?.workflow_cleanup !== "waiting") return "superseded";
    } catch { await ops.delay(interval); continue; }
    let state;
    try { state = classifyPullRequest(await ops.pullRequest(payload.repo, payload.prNumber)); }
    catch { state = "retry"; }
    if (state === "open" || state === "retry") { await ops.delay(interval); continue; }
    if (state === "closed") { await ops.project("retained"); await ops.notify("Codex workflow retained", "Pull request closed without merge; workspace and branch remain."); return "retained"; }
    const result = await cleanupTransaction(payload, ops, true);
    if (result.status === "busy") { await ops.delay(interval); continue; }
    if (result.status === "retry") { await ops.delay(interval); continue; }
    if (result.status === "missing") return "superseded";
    if (result.status === "removed") { await ops.notify("Codex workflow cleaned up", `Archived its Codex session and removed the worktree; branch ${payload.branch} remains.`); return "removed"; }
    await ops.project(result.status);
    await ops.notify(result.status === "partial" ? "Codex workflow partially cleaned up" : "Codex workflow cleanup stopped", result.reason);
    return result.status;
  }
}

module.exports = {
  associatedPr, classifyPullRequest, cleanupTransaction, decodePayload, encodePayload,
  handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch, withCleanupClaim,
};
