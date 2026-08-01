"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseGitWorktreeList } = require("./checkout-routing.js");

test("parses main, linked, detached, and prunable Git worktrees", () => {
  const entries = parseGitWorktreeList(`worktree /repo
HEAD a
branch refs/heads/main

worktree /repo/worktrees/feature
HEAD b
branch refs/heads/feature

worktree /repo/worktrees/review
detached

worktree /repo/worktrees/old
HEAD c
prunable gitdir file points to non-existent location
`);
  assert.deepEqual(entries, [
    { path: "/repo", bare: false, detached: false, prunable: false, branch: "refs/heads/main" },
    { path: "/repo/worktrees/feature", bare: false, detached: false, prunable: false, branch: "refs/heads/feature" },
    { path: "/repo/worktrees/review", bare: false, detached: true, prunable: false },
    { path: "/repo/worktrees/old", bare: false, detached: false, prunable: true },
  ]);
});
