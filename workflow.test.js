"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const net = require("node:net");
const test = require("node:test");
const {
  Lifecycle,
  buildCodexArgs,
  collisionReason,
  connectPipe,
  createPipeServer,
  makePipeName,
  parseGitHubRemote,
  parseTarget,
  sendPipeMessage,
  validateReport,
} = require("./workflow.js");

test("parses local issue forms and rejects a cross-repository URL", () => {
  assert.deepEqual(parseTarget("issue", "#42", "owner/repo"), {
    type: "issue", number: 42, input: "#42",
  });
  assert.deepEqual(parseTarget("issue", "fix the startup race", "owner/repo"), {
    type: "description", input: "fix the startup race", description: "fix the startup race",
  });
  assert.throws(
    () => parseTarget("issue", "https://github.com/other/repo/issues/42", "owner/repo"),
    /belongs to other\/repo/,
  );
  assert.throws(() => parseTarget("pr", "describe a PR", "owner/repo"), /URL or number/);
  assert.throws(() => parseTarget("issue", "#0", "owner/repo"), /positive safe integer/);
  assert.throws(() => parseTarget("issue", "https://github.com/owner/repo/issues/0", "owner/repo"), /positive safe integer/);
});

test("normalizes common GitHub origin forms", () => {
  assert.equal(parseGitHubRemote("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
});

test("refuses local, path, Git worktree, and Herdr collisions", () => {
  const base = { branch: "codex/issue-1-a", path: "C:\\Code\\.worktrees\\repo\\issue-1-a", gitWorktrees: [], herdrWorktrees: [] };
  assert.match(collisionReason({ ...base, branchExists: true, pathExists: false }), /local branch/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: true }), /path already exists/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: false, gitWorktrees: [{ path: base.path }] }), /Git worktree/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: false, herdrWorktrees: [{ path: "C:\\other", branch: base.branch }] }), /Herdr/);
  assert.equal(collisionReason({ ...base, branchExists: false, pathExists: false }), "");
});

test("controller lifecycle has explicit failure and cancellation terminals", () => {
  const cancelled = new Lifecycle();
  assert.equal(cancelled.transition("cancel"), "CANCELLED");

  const failed = new Lifecycle();
  failed.transition("submit");
  assert.equal(failed.transition("fail"), "FAILED");

  const complete = new Lifecycle();
  complete.transition("submit");
  complete.transition("provisioned");
  assert.equal(complete.transition("complete"), "COMPLETE");
  assert.throws(() => complete.transition("fail"), /invalid controller transition/);
});

test("validates phase and complete terminal reports", () => {
  assert.deepEqual(validateReport("issue", {
    type: "phase", phase: "reviewing", blocked: true, reason: "needs approval",
  }), { type: "phase", phase: "reviewing", blocked: true, reason: "needs approval" });
  assert.throws(() => validateReport("issue", { type: "phase", phase: "coding" }), /invalid workflow phase/);
  const terminal = { type: "terminal", status: "complete", "pr-url": "https://github.com/owner/repo/pull/1",
    "head-sha": "abc", "root-cause": "race", fix: "serialize", validation: "node --test passed",
    ponytail: "lean", "review-suite": "normal clean", ci: "green", coderabbit: "not installed",
    greptile: "clean", "remaining-action": "none" };
  assert.equal(validateReport("issue", terminal)["head-sha"], "abc");
  assert.throws(
    () => validateReport("issue", { type: "terminal", status: "complete", "pr-url": "x" }),
    /terminal report missing/,
  );
  assert.throws(
    () => validateReport("pr", { type: "terminal", status: "failed" }),
    /require --reason/,
  );
});

test("PR Codex launch is read-only and ignores head project instructions", () => {
  const args = buildCodexArgs("pr", "C:\\worktree", {
    helper: "C:\\plugin\\controller.js", pipe: "pipe-1", name: "herdr_workflow_deadbeef", disabled: ["github", "herdr_workflow"],
  });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(args.includes('projects."C:\\\\worktree".trust_level="untrusted"'), true);
  assert.equal(args.includes("project_doc_max_bytes=0"), true);
  assert.deepEqual(args.slice(0, 4), ["--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="xhigh"']);
  assert.equal(args.includes("apps") && args.includes("plugins"), true);
  assert.equal(args.includes("mcp_servers.github.enabled=false"), true);
  assert.equal(args.includes("mcp_servers.herdr_workflow.enabled=false"), true);
  assert.equal(args.some((arg) => arg.includes("mcp_servers.herdr_workflow_deadbeef.args=")), true);
});

test("MCP helper exposes only the controller bridge", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["controller.js", "mcp", "unused", "pr"], { input: requests, encoding: "utf8" });
  assert.equal(result.status, 0);
  const replies = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(replies[1].result.tools[0].name, "workflow");
  assert.equal(replies[1].result.tools[0].annotations.readOnlyHint, true);
  assert.equal(replies[1].result.tools.length, 1);
});

test("two pipe identities carry independent invocation messages", async (t) => {
  const firstPipe = makePipeName();
  const secondPipe = makePipeName();
  assert.notEqual(firstPipe, secondPipe);
  const received = [[], []];
  const first = await createPipeServer(firstPipe, { message(message) { received[0].push(message); return {}; } });
  const second = await createPipeServer(secondPipe, { message(message) { received[1].push(message); return {}; } });
  t.after(() => { first.close(); second.close(); });

  await Promise.all([
    sendPipeMessage(firstPipe, { type: "phase", phase: "planning" }),
    sendPipeMessage(secondPipe, { type: "phase", phase: "reviewing" }),
  ]);
  assert.deepEqual(received, [
    [{ type: "phase", phase: "planning" }],
    [{ type: "phase", phase: "reviewing" }],
  ]);
});

test("pipe server consumes repeated server errors after listening", async (t) => {
  const server = await createPipeServer(makePipeName(), { message() { return {}; } });
  t.after(() => server.close());
  assert.doesNotThrow(() => {
    server.emit("error", new Error("first late server error"));
    server.emit("error", new Error("second late server error"));
  });
});

test("pipe shutdown flushes accepted replies before closing", async (t) => {
  let releaseShutdown;
  const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const server = await createPipeServer(makePipeName(), { message() { releaseShutdown(); return {}; } });
  const client = await connectPipe(server.address());
  t.after(() => { client.socket.destroy(); if (server.listening) server.close(); });
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  const reply = client.request({ type: "cancel" });
  await shutdown;
  await server.shutdown();
  assert.equal((await reply).ok, true);
  await closed;
  assert.equal(client.socket.destroyed, true);
});

test("popup connection lifetime exposes close-before-submit cancellation", async (t) => {
  const pipe = makePipeName();
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = await createPipeServer(pipe, {
    message(message, connection) {
      if (message.type === "hello") connection.popup = true;
      return {};
    },
    disconnect(connection) {
      if (connection.popup) disconnected();
    },
  });
  t.after(() => server.close());
  const client = await connectPipe(pipe);
  assert.equal((await client.request({ type: "hello" })).ok, true);
  client.socket.end();
  await closed;
});

test("pipe close rejects an unanswered request", async (t) => {
  const pipe = makePipeName();
  const server = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise((resolve) => server.listen(pipe, resolve));
  t.after(() => server.close());
  const client = await connectPipe(pipe);
  await assert.rejects(client.request({ type: "phase", phase: "planning" }), /controller pipe closed/);
});
