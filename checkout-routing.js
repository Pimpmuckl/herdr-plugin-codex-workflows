"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function parseGitWorktreeList(content) {
  const worktrees = [];
  let current = null;
  for (const line of String(content || "").split(/\r?\n/)) {
    if (!line) {
      if (current?.path) worktrees.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      if (current?.path) worktrees.push(current);
      current = { path: value, bare: false, detached: false, prunable: false };
    } else if (current && key === "branch") {
      current.branch = value;
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "detached") {
      current.detached = true;
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }
  if (current?.path) worktrees.push(current);
  return worktrees;
}

function runGit(git, args) {
  const result = spawnSync(git, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return "";
  return result.stdout.trim();
}

function inspectGitCheckout(cwd, env = process.env) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const git = env.GIT_BIN_PATH || "git";
  const checkoutPath = runGit(git, ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!checkoutPath) return null;
  const listed = runGit(git, ["-C", cwd, "worktree", "list", "--porcelain"]);
  const worktrees = parseGitWorktreeList(listed);
  if (worktrees.length === 0) return null;

  const canonicalCheckout = canonicalPath(checkoutPath);
  const main = worktrees[0];
  const current = worktrees.find((entry) => canonicalPath(entry.path) === canonicalCheckout);
  if (!current || current.bare || current.prunable) return null;

  return {
    checkoutPath: canonicalCheckout,
    mainPath: canonicalPath(main.path),
    isLinkedWorktree: canonicalCheckout !== canonicalPath(main.path),
    branch: current.branch || "",
  };
}

module.exports = {
  canonicalPath,
  inspectGitCheckout,
  parseGitWorktreeList,
};
