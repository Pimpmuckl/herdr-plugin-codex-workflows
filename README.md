# Herdr Codex Workflows

Windows-only Herdr actions for turning a feature request or issue into an open
pull request, or understanding an existing pull request in an isolated Codex workspace.

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
key = "alt+u"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.feature-to-pr"
description = "feature or fix"

[[keys.command]]
key = "alt+shift+d"
type = "plugin_action"
command = "pimpmuckl.codex-workflows.cleanup-current-workflow"
description = "clean up Codex workflow"
```

Then run `herdr server reload-config`.

`issue-to-pr` accepts a complete issue or pull-request URL, partial link, or
number. A complete GitHub URL selects its repository; the other forms use the
current repository. Use Tab or Right/Down to add optional custom instructions.
Enter starts the workflow; Shift+Enter adds an instruction line. Long target
text scrolls horizontally, while instructions wrap and scroll vertically.
GitHub identifies whether the number is an issue or
pull request. Issue workflows pin the fetched default-branch SHA and start one Codex
parent that owns implementation, review, CI, and an open pull request. Review
workflows check out the exact pull-request head SHA and start a read-only review.

`feature-to-pr` uses the current repository. Its single multiline field accepts
the feature or fix description. Enter starts the workflow; Shift+Enter adds a line.

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

An implementation workflow with no pull request remains active. When Codex becomes idle
or done, its workspace is marked waiting. A blocked Codex stays marked blocked
for human input. In each case, Codex, the controller, worktree, and workspace
stay available for follow-up. The controller checks again after follow-up
activity settles. Once an implementation workflow has exactly one valid pull
request, or a pull-request review completes, the controller leaves the Codex
session and worktree available and exits. A detached watcher checks the associated
PR once per minute and changes the workspace label to `[I-3611] merged ✓` (or
the corresponding PR/task label) on merge. It does not stop or archive Codex,
or remove the worktree. Closed, unmerged PRs do not get a merged indicator.
Cleanup is manual by default. This applies to newly dispatched workflows;
existing completed workspaces are not retroactively watched.

To clean up automatically after the pull request merges, run
`herdr plugin config-dir pimpmuckl.codex-workflows` and create `config.json` in
that directory:

```json
{"auto-cleanup-on-pr-merge": true}
```

When enabled, a detached watcher waits for an unambiguous merge, then invokes
the same current-workflow cleanup used by `Alt+Shift+D`. An open or closed,
unmerged pull request keeps the agent and workspace intact. Cleanup waits for
the exact owning Codex agent to settle, quits it, archives its session, then
rechecks the local identity and cleanliness and asks Herdr to remove the
workspace and worktree without force. The workflow branch remains.

Failure and cancellation keep all workflow state. The
`cleanup-current-workflow` action uses the same archive-first transaction
without waiting for a merge. For an idle or waiting active workflow, it first
cancels the controller. It refuses a changed identity, dirty worktree, working
or changed agent, path outside
`C:\Code\.worktrees`, or an ambiguous Codex session. An archive failure removes
nothing; a failure after archive keeps the worktree for manual inspection.

A Herdr or machine restart loses an active watcher. The plugin has no registry
or startup recovery and does not reconstruct the wait after restart. Use the
manual cleanup action after inspection when its safety checks still pass.

Non-goals are persistent workflow state, dashboards, background services,
automatic recovery, automatic merge, force removal, and workflow-branch
deletion.
