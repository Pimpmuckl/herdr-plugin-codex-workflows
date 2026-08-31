"use strict";

const crypto = require("node:crypto"), net = require("node:net");
const os = require("node:os"), path = require("node:path");

const phases = new Set([
  "investigating",
  "planning",
  "implementing",
  "verifying",
  "reviewing",
  "ci-reviewers",
]);

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRepo(value) {
  return String(value || "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}
function targetNumber(value) {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error("issue or pull-request number must be a positive safe integer"); return number;
}

function parseGitHubRemote(value) {
  const remote = compact(value);
  const match = remote.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error("origin is not a supported GitHub repository");
  return normalizeRepo(match[1]);
}

function parseTarget(workflow, raw, currentRepo) {
  const input = compact(raw);
  if (!input) throw new Error("input is required");
  const url = input.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/([0-9]+)\/?$/i);
  if (url) {
    const repo = normalizeRepo(url[1]);
    if (repo !== normalizeRepo(currentRepo)) {
      throw new Error(`reference belongs to ${repo}, not ${normalizeRepo(currentRepo)}`);
    }
    if ((workflow === "issue" && url[2].toLowerCase() !== "issues")
      || (workflow === "pr" && url[2].toLowerCase() !== "pull")) {
      throw new Error(`expected a GitHub ${workflow === "issue" ? "issue" : "pull request"}`);
    }
    return { type: workflow, number: targetNumber(url[3]), input, url: `https://github.com/${repo}/${url[2].toLowerCase()}/${url[3]}` };
  }
  if (/^https?:\/\//i.test(input)) throw new Error("unsupported GitHub reference");
  const number = input.match(/^#?([0-9]+)$/);
  if (number) return { type: workflow, number: targetNumber(number[1]), input };
  if (workflow === "pr") throw new Error("enter a pull-request URL or number");
  return { type: "description", input, description: input };
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "task";
}

function makeIdentity(workflow, target, headSha = "") {
  const nonce = crypto.randomBytes(3).toString("hex");
  const stem = workflow === "pr"
    ? `review-pr-${target.number}-${headSha.slice(0, 8)}`
    : target.number
      ? `issue-${target.number}`
      : `task-${slug(target.description)}`;
  return {
    branch: `codex/${stem}-${nonce}`,
    directory: `${stem}-${nonce}`,
    agentName: `cw-${nonce}`,
    shortLabel: workflow === "pr" ? `PR-${target.number}` : target.number ? `I-${target.number}` : "Task",
  };
}

function normalizePath(value) {
  return path.resolve(String(value || "").replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase();
}

function collisionReason(input) {
  if (input.branchExists) return `local branch already exists: ${input.branch}`;
  if (input.pathExists) return `path already exists: ${input.path}`;
  if (input.gitWorktrees.some((item) => normalizePath(item.path) === normalizePath(input.path))) {
    return `Git worktree already uses path: ${input.path}`;
  }
  if (input.herdrWorktrees.some((item) => normalizePath(item.path) === normalizePath(input.path) || item.branch === input.branch)) {
    return "Herdr already has the requested branch or path";
  }
  return "";
}

function parseWorktreeList(content) {
  const entries = [];
  let current;
  for (const line of String(content || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

function buildCodexArgs(workflow, worktree, mcp = {}) {
  const args = [
    "--model", "gpt-5.6-sol",
    "--config", 'model_reasoning_effort="xhigh"',
    "--cd", worktree,
    "--sandbox", workflow === "pr" ? "read-only" : "danger-full-access",
    "--ask-for-approval", "never",
  ];
  if (workflow === "pr") args.push(
    "--config", `projects.${JSON.stringify(worktree)}.trust_level="untrusted"`,
    "--config", "project_doc_max_bytes=0", "--disable", "apps", "--disable", "plugins",
  );
  for (const name of mcp.disabled || []) args.push("--config", `mcp_servers.${name}.enabled=false`);
  if (mcp.helper) args.push(
    "--config", `mcp_servers.${mcp.name}.command="node"`,
    "--config", `mcp_servers.${mcp.name}.args=${JSON.stringify([mcp.helper, "mcp", mcp.pipe, workflow])}`,
  );
  return args;
}

class Lifecycle {
  constructor() {
    this.state = "COLLECTING";
  }

  transition(event) {
    const next = {
      COLLECTING: { submit: "PROVISIONING", cancel: "CANCELLED", fail: "FAILED" },
      PROVISIONING: { provisioned: "RUNNING", cancel: "CANCELLED", fail: "FAILED" },
      RUNNING: { complete: "COMPLETE", cancel: "CANCELLED", fail: "FAILED" },
    }[this.state]?.[event];
    if (!next) throw new Error(`invalid controller transition: ${this.state} -> ${event}`);
    this.state = next;
    return next;
  }
}

function validateReport(workflow, report) {
  if (report?.type === "phase") {
    if (!phases.has(report.phase)) throw new Error(`invalid workflow phase: ${report.phase}`);
    if (report.blocked && !report.reason) throw new Error("blocked reports require a reason");
    return report;
  }
  if (report?.type !== "terminal" || !["complete", "failed", "cancelled"].includes(report.status)) {
    throw new Error("invalid terminal report");
  }
  if (report.status !== "complete") {
    if (!report.reason) throw new Error(`${report.status} reports require --reason`);
    return report;
  }
  const required = workflow === "issue"
    ? ["pr-url", "head-sha", "root-cause", "fix", "validation", "ponytail", "review-suite", "ci", "coderabbit", "greptile", "remaining-action"]
    : ["purpose", "architecture", "minimality", "risks", "findings", "recommendations", "reviewed-head"];
  const missing = required.filter((field) => !compact(report[field]));
  if (missing.length) throw new Error(`terminal report missing: ${missing.join(", ")}`);
  return report;
}

function makePipeName() {
  const id = crypto.randomUUID();
  return process.platform === "win32" ? `\\\\.\\pipe\\herdr-codex-workflows-${id}` : path.join(os.tmpdir(), `herdr-codex-workflows-${id}.sock`);
}

function createPipeServer(pipeName, handlers) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const connection = {};
    let buffer = "";
    let chain = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        chain = chain.then(async () => {
          try {
            const reply = await handlers.message(JSON.parse(line), connection);
            socket.write(`${JSON.stringify({ ok: true, ...reply })}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
          }
        });
      }
    });
    socket.on("error", () => socket.destroy()).on("close", () => { sockets.delete(socket); handlers.disconnect?.(connection); });
  });
  server.shutdown = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(pipeName, () => resolve(server));
  });
}

function connectPipe(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const pending = [];
    let buffer = "";
    const fail = (error) => { reject(error); while (pending.length) pending.shift().reject(error); };
    socket.setEncoding("utf8");
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("controller pipe closed")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        pending.shift()?.resolve(reply);
      }
    });
    socket.once("connect", () => resolve({
      socket,
      request(message) {
        return new Promise((done, failed) => {
          pending.push({ resolve: done, reject: failed });
          socket.write(`${JSON.stringify(message)}\n`);
        });
      },
    }));
  });
}

async function sendPipeMessage(pipeName, message) {
  const client = await connectPipe(pipeName);
  const reply = await client.request(message);
  client.socket.end();
  if (!reply.ok) throw new Error(reply.error || "controller rejected report");
  return reply;
}

module.exports = { Lifecycle, buildCodexArgs, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, normalizePath, parseGitHubRemote, parseTarget, parseWorktreeList, sendPipeMessage, validateReport };
