"use strict";

const crypto = require("node:crypto"), net = require("node:net");
const os = require("node:os"), path = require("node:path");
const WORKTREE_ROOT = "C:\\Code\\.worktrees";

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
  const current = normalizeRepo(currentRepo);
  if (/^https?:\/\//i.test(input)) {
    let url;
    try { url = new URL(input); } catch { throw new Error("unsupported GitHub reference"); }
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.toLowerCase() !== "github.com" || parts.length < 4 || !["issues", "pull"].includes(parts[2].toLowerCase())) {
      throw new Error("unsupported GitHub reference");
    }
    const kind = parts[2].toLowerCase();
    if ((workflow === "issue" && kind !== "issues") || (workflow === "pr" && kind !== "pull")) {
      throw new Error(`expected a GitHub ${workflow === "issue" ? "issue" : "pull request"}`);
    }
    const repo = normalizeRepo(`${parts[0]}/${parts[1]}`), number = targetNumber(parts[3]);
    return { type: workflow, number, input, url: `https://github.com/${repo}/${kind}/${number}`, repo, repositorySource: "link" };
  }
  const reference = input.match(/(?:^|\/)(issues|pull)\/([0-9]+)(?:\/.*)?$/i);
  if (reference) {
    const kind = reference[1].toLowerCase();
    if ((workflow === "issue" && kind !== "issues") || (workflow === "pr" && kind !== "pull")) {
      throw new Error(`expected a GitHub ${workflow === "issue" ? "issue" : "pull request"}`);
    }
    return { type: workflow, number: targetNumber(reference[2]), input, repo: current, repositorySource: "current" };
  }
  const number = input.match(/^#?([0-9]+)$/);
  if (number) return { type: workflow, number: targetNumber(number[1]), input, repo: current, repositorySource: "current" };
  if (workflow === "pr") throw new Error("enter a pull-request URL or number");
  return { type: "description", input, description: input, repo: current, repositorySource: "current" };
}

function parseSameRepositoryTarget(workflow, raw, repo) {
  const target = parseTarget(workflow, raw, repo), current = normalizeRepo(repo);
  if (target.repo !== current) throw new Error(`reference belongs to ${target.repo}, not ${current}`);
  return target;
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

function makePipeName() {
  const id = crypto.randomUUID();
  return process.platform === "win32" ? `\\\\.\\pipe\\herdr-codex-workflows-${id}` : path.join(os.tmpdir(), `herdr-codex-workflows-${id}.sock`);
}

function createPipeServer(pipeName, handlers) {
  const sockets = new Map();
  const server = net.createServer((socket) => {
    const connection = {};
    let buffer = "";
    let chain = Promise.resolve();
    sockets.set(socket, () => chain);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        chain = chain.then(async () => {
          let reply;
          try {
            reply = { ok: true, ...await handlers.message(JSON.parse(line), connection) };
          } catch (error) {
            reply = { ok: false, error: error.message };
          }
          await new Promise((resolve) => socket.write(`${JSON.stringify(reply)}\n`, resolve));
        });
      }
    });
    socket.on("error", () => socket.destroy()).on("close", () => { sockets.delete(socket); handlers.disconnect?.(connection); });
  });
  server.shutdown = async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.allSettled([...sockets.values()].map((pending) => pending()));
    for (const socket of sockets.keys()) socket.destroy();
    return closed;
  };
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

module.exports = { Lifecycle, WORKTREE_ROOT, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, normalizePath, parseGitHubRemote, parseSameRepositoryTarget, parseTarget, parseWorktreeList };
