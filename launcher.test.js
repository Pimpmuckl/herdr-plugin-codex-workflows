"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  agentNameForSession,
  buildNewArguments,
  buildResumeArguments,
  buildShellCommand,
  discussionPrompt,
  parseTarget,
} = require("./launcher.js");
const {
  attachLiveAgents,
  discoverNamedSessions,
  normalizeConfiguredPath,
  orderSessionsForCwd,
  sessionNameRecordPatterns,
} = require("./session-discovery.js");

const config = {
  githubSessionNameTemplate: "{nameKind}-{number}",
  tabLabelTemplate: "{sessionName}",
  promptTemplate: "see {url}",
};

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("marks bare numbers for token matching and adds GitHub compatibility names", () => {
  const target = parseTarget("1158", config);
  assert.equal(target.sessionName, "1158");
  assert.equal(target.numericNameToken, "1158");
  assert.deepEqual(target.searchNames, ["1158", "gh-issue-1158"]);
});

test("uses compact canonical names and searches legacy aliases for GitHub URLs", () => {
  const target = parseTarget("https://github.com/ogulcancelik/herdr/issues/1158", config);
  assert.equal(target.sessionName, "issue-1158");
  assert.equal(target.label, "issue-1158");
  assert.deepEqual(target.searchNames, [
    "https://github.com/ogulcancelik/herdr/issues/1158",
    "issue-1158",
    "herdr#issue-1158",
    "herdr#1158",
    "1158",
    "gh-issue-1158",
  ]);
});

test("preserves ordinary display names and creates valid Herdr aliases", () => {
  const name = parseTarget("  P1 #1158 Windows idle CPU  ", config);
  assert.equal(name.sessionName, "P1 #1158 Windows idle CPU");
  assert.deepEqual(name.searchNames, [name.sessionName]);
  assert.match(name.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(agentNameForSession(name.sessionName).length <= 32, true);
  assert.notEqual(agentNameForSession("foo bar"), agentNameForSession("foo-bar"));
  assert.equal(name.shouldPrompt, false);
});

test("builds native new and resume arguments", () => {
  assert.deepEqual(buildNewArguments("pi", "issue name", "https://github.com/acme/repo/issues/42"), [
    "--name",
    "issue name",
    "--gh-context-url",
    "https://github.com/acme/repo/issues/42",
  ]);
  assert.deepEqual(buildNewArguments("codex", "issue name"), []);
  assert.deepEqual(buildNewArguments("claude", "issue name"), ["--name", "issue name"]);
  assert.deepEqual(buildResumeArguments(
    { harness: "pi", ref: "/tmp/pi.jsonl" },
    "https://github.com/acme/repo/pull/42",
  ), [
    "--session",
    "/tmp/pi.jsonl",
    "--gh-context-url",
    "https://github.com/acme/repo/pull/42",
  ]);
  assert.deepEqual(buildResumeArguments({ harness: "codex", id: "codex-id" }), ["resume", "codex-id"]);
  assert.deepEqual(buildResumeArguments({ harness: "claude", id: "claude-id" }), ["--resume", "claude-id"]);
});

test("quotes native commands sent through pane run", () => {
  assert.equal(
    buildShellCommand("pi", ["--session", "/tmp/session dir/can's.jsonl"]),
    `pi --session '/tmp/session dir/can'"'"'s.jsonl'`,
  );
});

test("normalizes pull request names and only GitHub targets receive an automatic prompt", () => {
  assert.equal(parseTarget("https://github.com/acme/repo/pull/42", config).sessionName, "pull-42");
  assert.equal(discussionPrompt(config, parseTarget("#42", config)), "see #42");
  assert.equal(discussionPrompt(config, parseTarget("plain name", config)), "");
});

test("prefilters only explicit session-name metadata with numeric boundaries", () => {
  const patterns = sessionNameRecordPatterns(
    "session_info",
    "name",
    ["discussion-743", "Fix (a+b)"],
    "743",
  ).map((pattern) => new RegExp(pattern));
  const matches = (entry) => patterns.some((pattern) => pattern.test(
    typeof entry === "string" ? entry : JSON.stringify(entry),
  ));

  assert.equal(matches({ type: "session_info", name: "discussion-743" }), true);
  assert.equal(matches({ type: "session_info", name: "Fix (a+b)" }), true);
  assert.equal(matches({ type: "session_info", name: "Fix #743 safely" }), true);
  assert.equal(matches('{"name":"743","type":"session_info"}'), true);
  assert.equal(matches({ type: "session_info", name: "issue-1743" }), false);
  assert.equal(matches({ type: "session_info", name: "issue-7432" }), false);
  assert.equal(matches({ type: "message", name: "discussion-743" }), false);
  assert.equal(matches({
    type: "message",
    message: { role: "user", content: '{"type":"session_info","name":"discussion-743"}' },
  }), false);

  const claude = sessionNameRecordPatterns("custom-title", "customTitle", ["discussion-743"])
    .map((pattern) => new RegExp(pattern));
  assert.equal(claude.some((pattern) => pattern.test(JSON.stringify({
    type: "custom-title",
    customTitle: "discussion-743",
  }))), true);
});

test("discovers exact latest names across Pi, Codex, and Claude", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-start-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const name = "1158";
  const env = {
    PI_CODING_AGENT_DIR: path.join(root, "pi"),
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  };

  const piPath = path.join(env.PI_CODING_AGENT_DIR, "sessions", "project", "pi.jsonl");
  await writeJsonl(piPath, [
    { type: "session", id: "pi-id", cwd: "/work/pi" },
    { type: "session_info", name },
  ]);
  await writeJsonl(path.join(env.PI_CODING_AGENT_DIR, "sessions", "project", "renamed.jsonl"), [
    { type: "session", id: "renamed-id", cwd: "/work/pi" },
    { type: "session_info", name },
    { type: "session_info", name: "something-else" },
  ]);

  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  await fs.writeFile(
    path.join(env.CODEX_HOME, "session_index.jsonl"),
    `${JSON.stringify({ id: "codex-id", thread_name: name, updated_at: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ id: "renamed-codex-id", thread_name: name, updated_at: "2026-01-02T00:00:00Z" })}\n${JSON.stringify({ id: "renamed-codex-id", thread_name: "other", updated_at: "2026-01-03T00:00:00Z" })}\n`,
  );
  await writeJsonl(
    path.join(env.CODEX_HOME, "sessions", "2026", "01", "01", "rollout-codex-id.jsonl"),
    [{ type: "session_meta", payload: { id: "codex-id", cwd: "/work/codex" } }],
  );

  await writeJsonl(path.join(env.CLAUDE_CONFIG_DIR, "projects", "project", "claude-id.jsonl"), [
    { type: "user", sessionId: "claude-id", cwd: "/work/claude" },
    { type: "custom-title", customTitle: name, sessionId: "claude-id" },
  ]);
  await writeJsonl(path.join(env.CLAUDE_CONFIG_DIR, "projects", "project", "renamed-id.jsonl"), [
    { type: "user", sessionId: "renamed-id", cwd: "/work/claude" },
    { type: "custom-title", customTitle: name, sessionId: "renamed-id" },
    { type: "custom-title", customTitle: "other", sessionId: "renamed-id" },
  ]);
  await writeJsonl(path.join(env.CLAUDE_CONFIG_DIR, "projects", "project", "subagents", "ignored.jsonl"), [
    { type: "custom-title", customTitle: name, sessionId: "ignored" },
  ]);

  const sessions = await discoverNamedSessions([name, "gh-issue-1158"], env);
  assert.deepEqual(
    sessions.map((session) => `${session.harness}:${session.id}`).sort(),
    ["claude:claude-id", "codex:codex-id", "pi:pi-id"],
  );

  const live = attachLiveAgents(sessions, [
    {
      pane_id: "w1:p2",
      agent_session: { agent: "pi", kind: "path", value: piPath },
    },
    {
      pane_id: "w1:p3",
      agent_session: { agent: "codex", kind: "id", value: "unrelated" },
    },
  ]);
  assert.equal(live.find((session) => session.harness === "pi").liveAgent.pane_id, "w1:p2");
  assert.equal(live.find((session) => session.harness === "codex").liveAgent, null);
});

test("matches a bare number as a standalone token in explicit session names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-start-number-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    PI_CODING_AGENT_DIR: path.join(root, "pi"),
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  };

  await writeJsonl(path.join(env.PI_CODING_AGENT_DIR, "sessions", "pr.jsonl"), [
    { type: "session", id: "pi-pr", cwd: "/work/pi" },
    { type: "session_info", name: "pr-1823" },
  ]);
  await writeJsonl(path.join(env.PI_CODING_AGENT_DIR, "sessions", "other.jsonl"), [
    { type: "session", id: "pi-other", cwd: "/work/pi" },
    { type: "session_info", name: "pr-11823" },
  ]);

  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  await fs.writeFile(
    path.join(env.CODEX_HOME, "session_index.jsonl"),
    `${JSON.stringify({ id: "codex-pr", thread_name: "herdr#pr-1823" })}\n`,
  );
  await writeJsonl(
    path.join(env.CODEX_HOME, "sessions", "rollout-codex-pr.jsonl"),
    [{ type: "session_meta", payload: { id: "codex-pr", cwd: "/work/codex" } }],
  );

  await writeJsonl(path.join(env.CLAUDE_CONFIG_DIR, "projects", "project", "claude-pr.jsonl"), [
    { type: "user", sessionId: "claude-pr", cwd: "/work/claude" },
    { type: "custom-title", customTitle: "Fix #1823 safely", sessionId: "claude-pr" },
  ]);

  const sessions = await discoverNamedSessions(["1823", "gh-issue-1823"], env, {
    numericToken: "1823",
  });
  assert.deepEqual(
    sessions.map((session) => `${session.harness}:${session.name}`).sort(),
    ["claude:Fix #1823 safely", "codex:herdr#pr-1823", "pi:pr-1823"],
  );
  assert.equal(sessions.every((session) => session.matchKind === "number"), true);
});

test("expands configured tilde paths", () => {
  assert.equal(normalizeConfiguredPath("~/sessions"), path.join(os.homedir(), "sessions"));
  assert.equal(normalizeConfiguredPath("~\\sessions"), path.join(os.homedir(), "sessions"));
});

test("orders exact matches before running and current-cwd token matches", () => {
  const sessions = [
    { id: "new", cwd: "/other", modifiedMs: 30, matchKind: "number" },
    { id: "local", cwd: "/current", modifiedMs: 20, matchKind: "number" },
    { id: "live", cwd: "/other", modifiedMs: 10, matchKind: "number", liveAgent: { pane_id: "w1:p1" } },
    { id: "exact", cwd: "/other", modifiedMs: 5, matchKind: "exact" },
  ];
  assert.deepEqual(orderSessionsForCwd(sessions, "/current").map((session) => session.id), [
    "exact",
    "live",
    "local",
    "new",
  ]);
});
