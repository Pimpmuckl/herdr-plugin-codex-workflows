# Herdr Codex Workflows

Windows-only Herdr actions for turning an issue into an open pull request and
for understanding an existing pull request in an isolated, read-only Codex
workspace.

## Install

```powershell
herdr plugin install Pimpmuckl/herdr-plugin-codex-workflows
```

For local development:

```powershell
git clone https://github.com/Pimpmuckl/herdr-plugin-codex-workflows.git
herdr plugin link .\herdr-plugin-codex-workflows
```

Requires Windows, Node.js 18+, Git, GitHub CLI authentication, Herdr 0.8.2+,
Codex CLI 0.151.0-fork.1 or a compatible later version, and the Ponytail and
Review Suite Codex plugins. Ask Pro is optional.

## Hotkeys

Add the actions you want to Herdr's `config.toml`:

```toml
[[keys.command]]
key = "alt+i"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.issue-to-pr"
description = "issue to pull request"

[[keys.command]]
key = "alt+u"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.understand-pr"
description = "understand pull request"

[[keys.command]]
key = "alt+shift+x"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.cleanup-current-workflow"
description = "clean up Codex workflow"
```

Then run `herdr server reload-config`.

`issue-to-pr` accepts a same-repository issue URL, an issue number, or a short
description. It pins the fetched default-branch SHA, creates a unique worktree,
and starts one Codex parent that owns implementation, review, CI, and an open
pull request. It never merges.

`understand-pr` accepts a same-repository pull-request URL or number. It checks
out the exact head SHA on a synthetic local branch and starts Codex with an
enforced read-only sandbox. It never pushes or posts to GitHub.

## Lifecycle and cleanup

Each action invocation has its own controller process and Windows named pipe.
Its state is only in memory: `COLLECTING -> PROVISIONING -> RUNNING ->` a
terminal result. Concurrent invocations do not share a queue or registry.

Success, failure, and cancellation leave the workspace, branch, worktree, and
transcript intact. Run `cleanup-current-workflow` from that workflow workspace
to remove only a terminal, clean, inactive plugin worktree under
`C:\Code\.worktrees`. Cleanup never uses force and leaves the branch.

A Herdr or machine restart loses the controller and its terminal metadata. The
plugin does not reconstruct or resume workflows after restart, and conservative
cleanup then refuses; use Herdr's native worktree controls after inspection.

Non-goals are persistent workflow state, dashboards, automatic recovery,
cross-repository references, automatic merge, and automatic cleanup.
