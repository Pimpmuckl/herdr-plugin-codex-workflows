# Herdr Codex Workflows

Windows-only Herdr action for turning an issue into an open pull request or
understanding an existing pull request in an isolated Codex workspace.

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
description = "issue or pull request"

[[keys.command]]
key = "alt+shift+x"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.cleanup-current-workflow"
description = "clean up Codex workflow"
```

Then run `herdr server reload-config`.

`issue-to-pr` accepts a complete issue or pull-request URL, partial link, or
number. A complete GitHub URL selects its repository; the other forms use the
current repository. GitHub identifies whether the number is an issue or pull
request. Issue workflows pin the fetched default-branch SHA and start one Codex
parent that owns implementation, review, CI, and an open pull request. Review
workflows check out the exact pull-request head SHA and start a read-only review.

For a full link to another repository, the plugin reuses a matching
`C:\Code\<repo>` checkout when present. Otherwise it clones to
`C:\Code\<owner>\<repo>` before creating the isolated worktree.

## Lifecycle and cleanup

Each action invocation has its own controller process and Windows named pipe
for its input and progress panes. Its state is only in memory: `COLLECTING -> PROVISIONING ->
RUNNING ->` a terminal result. Concurrent invocations do not share a queue or
registry. The controller uses Herdr's native `agent start` and `agent prompt`
lifecycle. When the canonical `codex` command advertises `--auto-account`, the
controller forwards that startup option through Herdr; otherwise the launch is
unchanged.

An issue workflow with no pull request remains active. When Codex becomes idle
or done, its workspace is marked waiting. A blocked Codex stays marked blocked
for human input. In each case, Codex, the controller, worktree, and workspace
stay available for follow-up. The controller checks again after follow-up
activity settles. Once an issue workflow has exactly one valid pull request,
or a pull-request review completes, the controller exits the owning Codex
process, releases its Herdr command slot, and starts the detached cleanup
watcher for that pull request.

An open pull request keeps the workspace intact. A closed, unmerged pull
request also keeps it and stops the watcher. When GitHub reports an unambiguous
merge, cleanup archives the exact owning Codex session, then rechecks the local
identity and cleanliness and asks Herdr to remove the workspace and worktree
without force. The workflow branch remains.

Failure and cancellation keep all workflow state. The
`cleanup-current-workflow` action uses the same archive-first transaction for a
terminal workflow without waiting for a merge. It refuses a changed identity,
dirty worktree, active controller or agent, path outside
`C:\Code\.worktrees`, or an ambiguous Codex session. An archive failure removes
nothing; a failure after archive keeps the worktree for manual inspection.

A Herdr or machine restart loses an active watcher. The plugin has no registry
or startup recovery and does not reconstruct the wait after restart. Use the
manual cleanup action after inspection when its safety checks still pass.

Non-goals are persistent workflow state, dashboards, background services,
automatic recovery, automatic merge, force removal, and workflow-branch
deletion.
