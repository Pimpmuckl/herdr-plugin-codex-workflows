"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  associatedPr, classifyPullRequest, cleanupTransaction, encodePayload, handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch,
} = require("./cleanup.js");

const payload = {
  version: 1, workflow: "issue", workspaceId: "w9", rootPaneId: "w9:p1",
  worktreePath: "C:\\Code\\.worktrees\\repo\\issue-9-a", repoRoot: "C:\\Code\\repo",
  repo: "owner/repo", branch: "codex/issue-9-a",
  sessionId: "019cbe72-e55b-73d1-87d8-4e01f1f75043", prNumber: 12,
};

function agent(overrides = {}) {
  return { workspace_id: "w9", pane_id: "w9:p1", agent_status: "idle",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: payload.sessionId }, ...overrides };
}

function fixture(options = {}) {
  const calls = [];
  let archived = false, released = false;
  const workspace = { workspace_id: "w9", tokens: {
    workflow_kind: "issue", workflow_state: options.running ? "RUNNING" : "complete", workflow_controller: options.running ? "active" : "inactive",
    workflow_branch: payload.branch, workflow_cleanup: "waiting",
    workflow_root_pane: payload.rootPaneId, workflow_session: payload.sessionId,
    ...(options.running ? { workflow_controller_pipe: "\\\\.\\pipe\\herdr-codex-workflows-test" } : {}),
  }, worktree: { is_linked_worktree: true, checkout_path: payload.worktreePath, repo_root: payload.repoRoot } };
  const ops = {
    async workspace() { calls.push("workspace"); return options.missing ? null : workspace; },
    async agents() {
      if (archived && options.postAgent) return [agent(options.postAgent)];
      if (released) return [];
      if (options.active) return [agent(), agent({ pane_id: "w9:p2", agent_status: "working" })];
      if (options.ownerWorking) return [agent({ agent_status: "working" })];
      if (options.rootReplacement) {
        return [agent({ agent_status: "working", agent_session: { source: "herdr:claude", kind: "id", value: "replacement" } })];
      }
      return options.noOwner ? [] : [agent()];
    },
    async git(_cwd, args) {
      if (args[0] === "remote") return "https://github.com/owner/repo.git";
      if (args[0] === "branch") return options.branch || payload.branch;
      if (args[0] === "status") return options.dirty || (archived && options.postDirty) || "";
      return `worktree ${payload.repoRoot}\nbranch refs/heads/master\n\nworktree ${payload.worktreePath}\nbranch refs/heads/${payload.branch}\n`;
    },
    async pullRequest() { calls.push("pull"); return options.pull || { state: "MERGED", mergedAt: "2026-09-01T00:00:00Z" }; },
    async release() {
      calls.push("release");
      if (options.ownerResumes) { const error = new Error("owner resumed"); error.retryable = true; throw error; }
      if (options.releaseFails) throw new Error("release failed");
      released = true;
    },
    async archive() { calls.push("archive"); if (options.archiveFails) throw new Error("archive failed"); archived = true; },
    async remove() { calls.push("remove"); if (options.removeFails) throw new Error("remove failed"); },
    async project(state) { calls.push(`project:${state}`); },
    async notify(title) { calls.push(`notify:${title}`); },
    async delay() { calls.push("delay"); },
  };
  if (options.abandon) ops.abandon = async () => {
    calls.push("abandon");
    Object.assign(workspace.tokens, { workflow_state: "cancelled", workflow_controller: "inactive", workflow_cleanup: "manual",
      workflow_root_pane: payload.rootPaneId, workflow_session: payload.sessionId });
  };
  ops.cleanup = async () => { calls.push("cleanup"); return cleanupTransaction(payload, ops); };
  return { calls, ops };
}

test("captures one root-pane Codex UUID and requires its owner to settle", () => {
  assert.equal(matchingSession([agent()], "w9", "w9:p1").agent_session.value, payload.sessionId);
  assert.equal(matchingSession([agent({ agent_status: "working" })], "w9", "w9:p1").agent_session.value, payload.sessionId);
  assert.throws(() => matchingSession([], "w9", "w9:p1"), /found 0/);
  assert.throws(() => matchingSession([agent(), agent()], "w9", "w9:p1"), /found 2/);
  assert.throws(() => matchingOwnedSession([agent({ agent_status: "working" })], "w9", "w9:p1", payload.sessionId), /still active/);
  assert.throws(() => matchingOwnedSession([agent()], "w9", "w9:p1", "019cbe72-e55b-73d1-87d8-4e01f1f75044"), /session changed/);
});

test("associates implementation terminal URLs and the original review PR", () => {
  assert.equal(associatedPr("issue", { "pr-url": "https://github.com/owner/repo/pull/12" }, null, "owner/repo"), 12);
  assert.equal(associatedPr("task", { "pr-url": "https://github.com/owner/repo/pull/13" }, null, "owner/repo"), 13);
  assert.equal(associatedPr("pr", {}, 7, "owner/repo"), 7);
  assert.throws(() => associatedPr("issue", { "pr-url": "https://github.com/other/repo/pull/12" }, null, "owner/repo"), /belongs to other\/repo/);
});

test("accepts task workflow cleanup metadata", async () => {
  const taskPayload = { ...payload, workflow: "task", branch: "codex/task-abc123", worktreePath: "C:\\Code\\.worktrees\\repo\\task-abc123" };
  assert.doesNotThrow(() => encodePayload(taskPayload));
  const workspace = await fixture().ops.workspace();
  assert.equal(manualWorkspace({ ...workspace, tokens: { ...workspace.tokens, workflow_kind: "task" } }).tokens.workflow_kind, "task");
});

test("classifies only unambiguous GitHub merge states", () => {
  assert.equal(classifyPullRequest({ state: "OPEN", mergedAt: null }), "open");
  assert.equal(classifyPullRequest({ state: "MERGED", mergedAt: "now" }), "merged");
  assert.equal(classifyPullRequest({ state: "CLOSED", mergedAt: null }), "closed");
  assert.equal(classifyPullRequest({ state: "MERGED", mergedAt: null }), "retry");
});

test("detached watcher arms before authorization and IPC release", async () => {
  const order = []; let invocation;
  class Child extends EventEmitter {
    constructor() { super(); this.connected = true; }
    disconnect() { order.push("disconnect"); this.connected = false; }
    unref() { order.push("unref"); }
    kill() { order.push("kill"); }
  }
  await handoffWatcher("controller.js", payload, async () => order.push("authorize"), { spawn(command, args, options) {
    invocation = { command, args, options }; const child = new Child();
    queueMicrotask(() => { order.push("armed"); child.emit("message", { type: "armed" }); }); return child;
  } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  assert.equal(invocation.options.detached && invocation.options.windowsHide && !invocation.options.shell, true);
  assert.deepEqual(order, ["armed", "authorize", "disconnect", "unref"]);
});

test("refuses concrete identity, dirty, and active-agent mismatches before archive", async () => {
  for (const options of [{ branch: "other" }, { dirty: " M file" }, { active: true }, { rootReplacement: true }]) {
    const { calls, ops } = fixture(options);
    assert.equal((await cleanupTransaction(payload, ops)).status, "stopped");
    assert.equal(calls.includes("archive"), false);
  }
});

test("waits for the exact owning agent to become idle before cleanup", async () => {
  const { calls, ops } = fixture({ ownerWorking: true });
  assert.deepEqual(await cleanupTransaction(payload, ops), { status: "retry", reason: "owning Codex session is still active" });
  assert.equal(calls.includes("release"), false);
  assert.equal(calls.includes("archive"), false);
  const resumed = fixture({ ownerResumes: true });
  assert.deepEqual(await cleanupTransaction(payload, resumed.ops), { status: "retry", reason: "Owning Codex session is still active." });
  assert.equal(resumed.calls.includes("archive"), false);
});

test("cleanup archives, rechecks, then removes without querying GitHub", async () => {
  const cleanup = fixture();
  assert.equal((await cleanupTransaction(payload, cleanup.ops)).status, "removed");
  assert.deepEqual(cleanup.calls.filter((call) => ["workspace", "release", "archive", "remove"].includes(call)), ["workspace", "release", "archive", "workspace", "remove"]);
  assert.equal(cleanup.calls.includes("pull"), false);
  assert.equal((await cleanupTransaction(payload, fixture({ noOwner: true }).ops)).status, "removed");
  const manual = fixture();
  const manualData = await manual.ops.workspace();
  assert.throws(() => manualWorkspace({ ...manualData, tokens: { workflow_kind: "issue", workflow_state: "complete", workflow_controller: "inactive" } }), /no Codex workflow/);
  assert.throws(() => manualWorkspace({ ...manualData, tokens: { ...manualData.tokens, workflow_controller: "active", workflow_root_pane: payload.rootPaneId, workflow_session: payload.sessionId } }), /inconsistent/);
  const manualIdentity = manualWorkspace({ ...manualData, tokens: { ...manualData.tokens, workflow_root_pane: payload.rootPaneId, workflow_session: payload.sessionId } });
  assert.equal(manualIdentity.tokens.workflow_session, payload.sessionId);
  assert.equal((await cleanupTransaction({ ...payload, prNumber: null }, manual.ops)).status, "removed");
  assert.equal(manual.calls.includes("pull"), false);

  const waiting = fixture({ running: true, abandon: true });
  const waitingWorkspace = await waiting.ops.workspace();
  delete waitingWorkspace.tokens.workflow_root_pane;
  delete waitingWorkspace.tokens.workflow_session;
  assert.equal(manualWorkspace(waitingWorkspace, [agent()]).tokens.workflow_session, payload.sessionId);
  assert.equal((await cleanupTransaction(payload, waiting.ops)).status, "removed");
  assert.deepEqual(waiting.calls.filter((call) => ["abandon", "release", "archive", "remove"].includes(call)), ["abandon", "release", "archive", "remove"]);

  const resumed = fixture({ running: true, abandon: true, ownerResumes: true });
  assert.equal((await cleanupTransaction(payload, resumed.ops)).status, "retry");
  assert.equal((await resumed.ops.workspace()).tokens.workflow_cleanup, "manual");
  assert.equal(resumed.calls.includes("archive"), false);
});

test("archive failure never removes; postflight failure is partial", async () => {
  const archiveFailure = fixture({ archiveFails: true });
  assert.equal((await cleanupTransaction(payload, archiveFailure.ops)).status, "stopped");
  assert.equal(archiveFailure.calls.includes("remove"), false);
  const releaseFailure = fixture({ releaseFails: true });
  assert.equal((await cleanupTransaction(payload, releaseFailure.ops)).status, "stopped");
  assert.equal(releaseFailure.calls.includes("archive"), false);
  const partial = fixture({ postDirty: " M file" });
  assert.equal((await cleanupTransaction(payload, partial.ops)).status, "partial");
  assert.equal(partial.calls.includes("remove"), false);
  const replacement = fixture({ postAgent: { agent_session: { source: "herdr:codex", kind: "id", value: "019cbe72-e55b-73d1-87d8-4e01f1f75044" } } });
  assert.equal((await cleanupTransaction(payload, replacement.ops)).status, "partial");
});

test("missing workspace is a benign duplicate and watcher polls sequentially", async () => {
  const missing = fixture({ missing: true });
  assert.equal((await cleanupTransaction(payload, missing.ops)).status, "missing");
  const live = fixture(); let views = 0;
  live.ops.pullRequest = async () => (++views === 1 ? { state: "OPEN", mergedAt: null } : { state: "MERGED", mergedAt: "now" });
  assert.equal(await watch(payload, live.ops, 0), "removed");
  assert.equal(live.calls.filter((call) => call === "delay").length, 1);
  assert.equal(views, 2);
  assert.equal(live.calls.includes("cleanup"), true);
  const superseded = fixture(), currentWorkspace = superseded.ops.workspace; let reads = 0;
  superseded.ops.workspace = async () => ++reads === 1 ? currentWorkspace() : null;
  assert.equal(await watch(payload, superseded.ops, 0), "superseded");
});

test("serializes concurrent cleanup requests", async () => {
  const first = fixture(), second = fixture(); let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  first.ops.archive = async () => { first.calls.push("archive"); started(); await blocked; };
  const running = cleanupTransaction(payload, first.ops);
  await entered;
  assert.equal((await cleanupTransaction({ ...payload, sessionId: "019cbe72-e55b-73d1-87d8-4e01f1f75044" }, second.ops)).status, "busy");
  assert.equal(second.calls.includes("archive"), false);
  release();
  assert.equal((await running).status, "removed");
});

test("merge indicator retries without cleanup, even with active agents and dirty files", async () => {
  const live = fixture({ ownerWorking: true, dirty: " M file" });
  let views = 0, merged = 0;
  live.ops.pullRequest = async () => {
    if (++views === 1) throw new Error("offline");
    return views === 2 ? { state: "OPEN" } : { state: "MERGED", mergedAt: "now" };
  };
  live.ops.merged = async () => { merged++; };
  assert.equal(await watch({ ...payload, indicatorOnly: true }, live.ops, 0), "merged");
  assert.equal(merged, 1);
  assert.equal(views, 3);
  assert.equal(live.calls.some((call) => ["cleanup", "release", "archive", "remove"].includes(call)), false);
  for (const options of [{ missing: true }, { pull: { state: "CLOSED" } }]) {
    const retained = fixture(options);
    retained.ops.merged = async () => assert.fail("must not mark missing/closed PR as merged");
    assert.equal(await watch({ ...payload, indicatorOnly: true }, retained.ops, 0), options.missing ? "superseded" : "closed");
  }
});
