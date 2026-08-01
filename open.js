#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const result = spawnSync(
  herdr,
  [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "ogulcancelik.github-start",
    "--entrypoint",
    "prompt",
    "--focus",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? (result.error ? 1 : 0));
