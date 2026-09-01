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

`issue-to-pr` accepts a complete issue URL, an issue number, a partial issue
link, or a short description. A complete GitHub URL selects its repository;
the other forms use the current repository. It pins the fetched default-branch
SHA, creates a unique worktree, and starts one Codex parent that owns
implementation, review, CI, and an open pull request. It never merges.

`understand-pr` accepts a complete pull-request URL, partial link, or number
with the same repository-selection rule. It checks out the exact head SHA on a
synthetic local branch and starts Codex with an enforced read-only sandbox. It
never pushes or posts to GitHub.

For a full link to another repository, the plugin reuses a matching
`C:\Code\<repo>` checkout when present. Otherwise it clones to
`C:\Code\<owner>\<repo>` before creating the isolated worktree.

## Lifecycle and cleanup

Each action invocation has its own controller process and Windows named pipe.
Its state is only in memory: `COLLECTING -> PROVISIONING -> RUNNING ->` a
terminal result. Concurrent invocations do not share a queue or registry.

After a successful workflow, the controller exits the owning Codex process,
releases its Herdr command slot, and leaves the exact session ready to archive.
A detached watcher waits for the associated pull request. An open pull request
keeps the workspace intact. A closed, unmerged pull request also keeps it and
stops the watcher. When GitHub reports an unambiguous merge, cleanup first exits
and archives the exact owning Codex session, then rechecks the local identity and
cleanliness and asks Herdr to remove the workspace and worktree without force.
The workflow branch remains.

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
