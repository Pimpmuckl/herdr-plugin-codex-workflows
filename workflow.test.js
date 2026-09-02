"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const {
  canonicalRepositoryRoot, codexAgentStartArgs, completeGitHubTarget, controllerProtocol, openInputPopup,
  implementationPullRequest, isAgentPromptStalled, monitor, openProgressPane, popupInputKey, popupInputView, progressView, resolveRepository,
  sourceDirectory, stalledPromptRecovery, stalledPromptRecoveryCommands, waitForActivity,
} = require("./controller.js");
const { issuePrompt, prPrompt, taskPrompt } = require("./prompts.js");
const {
  Lifecycle,
  collisionReason,
  connectPipe,
  createPipeServer,
  makeIdentity,
  makePipeName,
  parseGitHubRemote,
  parseTarget,
} = require("./workflow.js");

test("full links select their repository while shorthand stays current", () => {
  assert.deepEqual(parseTarget("#42", "owner/repo"), {
    number: 42, input: "#42", repo: "owner/repo", repositorySource: "current",
  });
  assert.deepEqual(parseTarget("github.com/other/repo/issues/42", "owner/repo"), {
    number: 42, input: "github.com/other/repo/issues/42", repo: "owner/repo", repositorySource: "current",
  });
  assert.deepEqual(parseTarget("pull/7", "owner/repo"), {
    number: 7, input: "pull/7", repo: "owner/repo", repositorySource: "current",
  });
  assert.equal(parseTarget("https://github.com/Other/Repo/pull/7/files", "owner/repo").repo, "other/repo");
  assert.deepEqual(parseTarget("https://github.com/Other/Repo/issues/42?notification=1", "owner/repo"), {
    number: 42, input: "https://github.com/Other/Repo/issues/42?notification=1", repo: "other/repo", repositorySource: "link",
  });
  assert.throws(() => parseTarget("fix the startup race", "owner/repo"), /URL or number/);
  assert.throws(() => parseTarget("#0", "owner/repo"), /positive safe integer/);
  assert.throws(() => parseTarget("https://github.com/owner/repo/issues/0", "owner/repo"), /positive safe integer/);
});

test("GitHub issue objects select the workflow and canonical URL", () => {
  const target = parseTarget("#42", "owner/repo");
  assert.deepEqual(completeGitHubTarget(target, { number: 42, html_url: "https://github.com/owner/repo/issues/42" }), {
    ...target, type: "issue", url: "https://github.com/owner/repo/issues/42",
  });
  assert.equal(completeGitHubTarget(target, {
    number: 42, html_url: "https://github.com/owner/repo/pull/42", pull_request: {},
  }).type, "pr");
  assert.throws(() => completeGitHubTarget(target, { number: 41 }), /requested issue or pull request/);
});

test("resolves repositories by full owner and name identity", () => {
  const codeRoot = "C:\\Code", current = { root: "C:\\Code\\current", repo: "owner/current", repoName: "current" };
  const matching = { root: "C:\\Code\\target", repo: "other/target", repoName: "target" };
  assert.equal(resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: (root) => root === path.join(codeRoot, "target"),
    identify: () => matching,
    clone: () => assert.fail("matching checkout must be reused"),
  }), matching);

  const clones = [], canonical = path.join(codeRoot, "other", "target");
  assert.deepEqual(resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: () => false,
    clone: (repo, root) => clones.push([repo, root]),
    identify: (root) => ({ root, repo: "other/target", repoName: "target" }),
  }), { root: canonical, repo: "other/target", repoName: "target" });
  assert.deepEqual(clones, [["other/target", canonical]]);

  assert.throws(() => resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: (root) => root === canonical,
    identify: () => ({ root: canonical, repo: "another/target", repoName: "target" }),
  }), /belongs to another\/target/);
});

test("renders repository provenance and launch checkpoints", () => {
  const loading = progressView({ status: "running", step: 0, repo: "owner/repo", repositorySource: "current" }, 0);
  assert.match(loading, /owner\/repo \(current workspace\)/);
  assert.match(loading, /\| Resolve repository/);
  assert.match(loading, /0%/);
  assert.equal(loading.trim().split("\n").length, 2);
  const started = progressView({ status: "started", step: 4, repo: "other/repo", repositorySource: "link" });
  assert.match(started, /other\/repo \(full link\)/);
  assert.match(started, /Codex started/);
  assert.match(started, /100%/);
});

test("normalizes common GitHub origin forms", () => {
  assert.equal(parseGitHubRemote("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
});

test("opens popup on Herdr's active pane without rejected target flags", () => {
  let args;
  openInputPopup("pipe-1", "task", (value) => { args = value; });
  assert.equal(args.includes("--workspace"), false);
  assert.equal(args.includes("--target-pane"), false);
  assert.equal(args[args.indexOf("--cwd") + 1], __dirname);
  assert.equal(args[args.indexOf("HERDR_CODEX_WORKFLOW_MODE=task") - 1], "--env");
  assert.equal(args.at(-1), "--focus");
});

test("popup edits and renders multiline custom instructions", () => {
  const state = { active: 0, values: ["", ""] };
  popupInputKey(state, "#42", {});
  assert.match(popupInputView(state, 40), /\x1b\[1;\d+H$/);
  popupInputKey(state, "", { name: "down" });
  popupInputKey(state, "focus startup", {});
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[13;2u" }), "render");
  popupInputKey(state, "then test", {});
  assert.deepEqual(state, { active: 1, values: ["#42", "focus startup\nthen test"] });
  assert.match(popupInputView(state, 40, 6), /─+\n> Custom instructions:\n  focus startup\n  then test\x1b\[5;\d+H$/);
  assert.equal(popupInputKey(state, "", { name: "return" }), "submit");
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[27u" }), "cancel");
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[99;5u" }), "cancel");

  state.values[1] = "x".repeat(100);
  const long = popupInputView(state, 40, 6).replace(/^\x1b\[2J\x1b\[H/, "").replace(/\x1b\[6;\d+H$/, "");
  assert.equal(long.split("\n").length, 6);
  assert.ok(long.split("\n").every((line) => [...line].length < 40));

  const promptInput = { repo: "owner/repo", target: { url: "https://github.com/owner/repo/issues/42" }, prUrl: "https://github.com/owner/repo/pull/42", instructions: "focus startup\nthen test" };
  assert.match(issuePrompt(promptInput), /Important! Custom Instructions:\nfocus startup\nthen test/);
  assert.match(prPrompt(promptInput), /Important! Custom Instructions:\nfocus startup\nthen test/);
  assert.doesNotMatch(issuePrompt({ ...promptInput, instructions: "" }), /Custom Instructions/);
  assert.match(issuePrompt(promptInput), /\$review-suite:review \(note: herdrdev\/herdr uses mode fast\)/);
  assert.match(prPrompt(promptInput), /\$review-suite:review \(note: herdrdev\/herdr uses mode fast\)/);
});

test("task input and prompt preserve a multiline request", () => {
  const state = { mode: "task", active: 0, values: ["Build the thing", ""] };
  assert.match(popupInputView(state, 40, 5), /Describe the feature or fix:\n  Build the thing/);
  assert.equal(popupInputKey(state, "\x1b[13;2u", {}), "render");
  popupInputKey(state, "Then test it", {});
  assert.equal(state.values[0], "Build the thing\nThen test it");
  assert.equal(popupInputKey(state, "", { name: "return" }), "submit");

  const identity = makeIdentity("task");
  assert.match(identity.branch, /^codex\/task-[0-9a-f]{6}$/);
  assert.equal(identity.directory, identity.branch.slice("codex/".length));
  const prompt = taskPrompt({ repo: "owner/repo", request: state.values[0] });
  assert.match(prompt, /Build the thing\nThen test it/);
  assert.match(prompt, /tricky.*\$ask-pro:ask-pro.*otherwise.*\$review-suite:review-plan/);
  assert.doesNotMatch(prompt, /Custom Instructions/);
});

test("shorthand follows the focused pane repository", () => {
  assert.equal(sourceDirectory({
    focused_pane_cwd: "C:\\Code\\plugin",
    worktree: { repo_root: "C:\\Users\\jonat\\.codex" },
    workspace_cwd: "C:\\Users\\jonat\\.codex",
  }), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot(
    "C:\\Code\\.worktrees\\plugin\\review-pr-1", "C:\\Code\\plugin\\.git",
  ), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot("C:\\Code\\plugin", ".git"), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot(
    "C:\\Code\\parent\\submodule", "C:\\Code\\parent\\.git\\modules\\submodule",
  ), "C:\\Code\\parent\\submodule");
});

test("opens a slim unfocused progress split under the invoking pane", () => {
  let openArgs, resizeArgs;
  openProgressPane("pipe-1", { focused_pane_id: "w1:p2" }, (value) => {
    openArgs = value;
  }, (value) => { resizeArgs = value; });
  assert.deepEqual(openArgs.slice(openArgs.indexOf("--placement"), openArgs.indexOf("--cwd")), [
    "--placement", "split", "--target-pane", "w1:p2", "--direction", "down",
  ]);
  assert.equal(openArgs.at(-1), "--no-focus");
  assert.deepEqual(resizeArgs, ["pane", "resize", "--pane", "w1:p2", "--direction", "down", "--amount", "0.4"]);
});

test("progress can observe launch status after input submits", async () => {
  const lifecycle = new Lifecycle(), runtime = { launch: { status: "collecting", step: 0 } };
  let submitted, hello = false, progressHello = false;
  const protocol = controllerProtocol(runtime, lifecycle, () => { hello = true; }, (value) => { submitted = value; }, () => { progressHello = true; });
  const inputConnection = {}, progressConnection = {};
  await protocol.message({ type: "hello", role: "input" }, inputConnection);
  await protocol.message({ type: "input", target: "#42", instructions: "focus startup\r\nthen test" }, inputConnection);
  runtime.launch.status = "running";
  await protocol.message({ type: "hello", role: "progress" }, progressConnection);
  assert.equal(hello, true);
  assert.equal(progressHello, true);
  assert.deepEqual(submitted, { target: "#42", instructions: "focus startup\nthen test" });
  assert.equal((await protocol.message({ type: "status" }, progressConnection)).launch.status, "running");

  const taskLifecycle = new Lifecycle(), taskRuntime = { workflow: "task", launch: {} };
  let taskSubmission;
  const taskProtocol = controllerProtocol(taskRuntime, taskLifecycle, () => {}, (value) => { taskSubmission = value; });
  const taskConnection = {};
  await taskProtocol.message({ type: "hello", role: "input" }, taskConnection);
  await taskProtocol.message({ type: "input", request: "Build it\r\nThen test it" }, taskConnection);
  assert.deepEqual(taskSubmission, { request: "Build it\nThen test it" });
});

test("forwards Codex++ auto-account only when the executable advertises it", () => {
  const base = ["agent", "start", "worker", "--kind", "codex", "--pane", "w1:p2"];
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --auto-account  Immediately select an account"), [
    ...base, "--", "--auto-account",
  ]);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --version  Print version"), base);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --auto-accounting  Not the capability"), base);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => { throw new Error("probe failed"); }), base);
});

test("stalled prompts submit the pasted composer without repeating the prompt", () => {
  assert.equal(isAgentPromptStalled('{"error":{"code":"agent_prompt_stalled"}}'), true);
  assert.equal(isAgentPromptStalled('{"error":{"code":"timeout"}}'), false);
  assert.deepEqual(stalledPromptRecoveryCommands("worker"), [
    ["agent", "send-keys", "worker", "enter"],
    ["agent", "wait", "worker", "--until", "working", "--until", "blocked", "--timeout", "5000"],
  ]);
  assert.equal(stalledPromptRecovery("idle"), "submit");
  assert.equal(stalledPromptRecovery("done"), "submit");
  assert.equal(stalledPromptRecovery("working"), "started");
  assert.equal(stalledPromptRecovery("blocked"), "started");
  assert.equal(stalledPromptRecovery(), "failed");
  assert.equal(stalledPromptRecovery("unknown"), "failed");
});

test("issue completion waits for a PR and rechecks after follow-up activity", async () => {
  const lifecycle = new Lifecycle();
  lifecycle.transition("submit");
  lifecycle.transition("provisioned");
  const runtime = {
    workflow: "issue", lifecycle, terminal: null, prompt: { finished: true },
    identity: { agentName: "worker" }, worktree: { workspace: { workspace_id: "w1" } },
  };
  let checks = 0, resume, reachedWaiting;
  const waiting = new Promise((resolve) => { reachedWaiting = resolve; });
  const paused = new Promise((resolve) => { resume = resolve; });
  const projections = [];
  let completed = false;
  const monitoring = monitor(runtime, {}, {
    workspace: () => ({}), agent: () => ({ agent_status: "idle" }),
    implementationPullRequest: () => ++checks === 1 ? null : ({ number: 12, url: "https://github.com/owner/repo/pull/12", headRefOid: "head" }),
    project: (_runtime, state) => projections.push(state), projectTerminal: () => {},
    activity: async () => {
      reachedWaiting();
      await paused;
      return { agent_status: "working" };
    },
  }).then(() => { completed = true; });
  await waiting;
  assert.equal(completed, false);
  assert.equal(runtime.terminal, null);
  assert.equal(runtime.lifecycle.state, "RUNNING");
  resume();
  await monitoring;
  assert.equal(checks, 2);
  assert.deepEqual(projections, ["waiting", "working"]);
  assert.equal(runtime.terminal["pr-url"], "https://github.com/owner/repo/pull/12");
});

test("task completion uses the implementation pull request path", async () => {
  const lifecycle = new Lifecycle();
  lifecycle.transition("submit");
  lifecycle.transition("provisioned");
  const runtime = {
    workflow: "task", lifecycle, terminal: null, prompt: { finished: true },
    identity: { agentName: "worker" }, worktree: { workspace: { workspace_id: "w1" } },
  };
  await monitor(runtime, {}, {
    workspace: () => ({}), agent: () => ({ agent_status: "idle" }),
    implementationPullRequest: () => ({ number: 13, url: "https://github.com/owner/repo/pull/13", headRefOid: "head" }),
    projectTerminal: () => {},
  });
  assert.equal(runtime.terminal["pr-url"], "https://github.com/owner/repo/pull/13");
});

test("implementation PR lookup distinguishes zero, multiple, and invalid matches", () => {
  const runtime = { identity: { branch: "codex/issue-1-a" }, baseBranch: "master", baseSha: "base", worktree: { path: "." } };
  const repository = { repo: "owner/repo" };
  assert.equal(implementationPullRequest(runtime, repository, []), null);
  assert.throws(() => implementationPullRequest(runtime, repository, [{}, {}]), /multiple open pull requests/);
  assert.throws(() => implementationPullRequest(runtime, repository, [{}]), /does not connect the pinned base/);
});

test("activity wait returns control when its agent disappears", () => {
  assert.equal(waitForActivity("worker", () => { const error = new Error(); error.herdrCode = "agent_not_running"; throw error; }), null);
  assert.throws(() => waitForActivity("worker", () => { throw new Error("offline"); }), /offline/);
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

test("two pipe identities carry independent invocation messages", async (t) => {
  const firstPipe = makePipeName();
  const secondPipe = makePipeName();
  assert.notEqual(firstPipe, secondPipe);
  const received = [[], []];
  const first = await createPipeServer(firstPipe, { message(message) { received[0].push(message); return {}; } });
  const second = await createPipeServer(secondPipe, { message(message) { received[1].push(message); return {}; } });
  t.after(() => { first.close(); second.close(); });

  const [firstClient, secondClient] = await Promise.all([connectPipe(firstPipe), connectPipe(secondPipe)]);
  await Promise.all([
    firstClient.request({ type: "status" }),
    secondClient.request({ type: "status" }),
  ]);
  firstClient.socket.end(); secondClient.socket.end();
  assert.deepEqual(received, [
    [{ type: "status" }],
    [{ type: "status" }],
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
