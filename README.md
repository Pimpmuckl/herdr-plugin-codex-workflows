# Herdr GitHub Start

Named-session finder and launcher for Pi, Codex, and Claude Code.

Press a keybind and enter a native session name or GitHub target. The popup
searches user-assigned names in all three harnesses, shows what it found, focuses
a matching live Herdr agent, resumes a selected saved session, or offers to start
a new named session.

## Install

```sh
herdr plugin install ogulcancelik/herdr-plugin-github-start
```

For local development:

```sh
git clone https://github.com/ogulcancelik/herdr-plugin-github-start.git
cd herdr-plugin-github-start
herdr plugin link .
```

## Keybind

```toml
[[keys.command]]
key = "alt+g"
type = "plugin_action"
command = "ogulcancelik.github-start.open"
description = "find named agent session"
```

Then reload Herdr config:

```sh
herdr server reload-config
```

## Search behavior

The search reads only the explicit naming records used by each harness:

- Pi: the latest `session_info.name` in each session JSONL
- Codex: the latest `thread_name` per id in `session_index.jsonl`
- Claude Code: the latest `custom-title.customTitle` in each session JSONL

Ordinary text is matched exactly. A bare number such as `1158` also matches that
number as a standalone token inside a session name, including `pr-1158`,
`herdr#pr-1158`, and `Fix #1158 safely`, but not `pr-11158`. Exact matches appear
first. GitHub targets also search exact compatible names so existing sessions
remain findable. For example, a Herdr issue URL searches repository-qualified,
numeric, and legacy `gh-issue-1158` names. Transcript contents are never treated
as session names.

A result shows whether it is already running, its harness, cwd, activity age,
and native id. One or many results use the same explicit picker. A running
result focuses its existing Herdr pane. A saved result resumes its native path
or UUID. No result is reported explicitly before the harness picker opens.

The popup works from any focused workspace, but every new or resumed session is
launched in the open main `herdr` workspace with its cwd set to that workspace's
repository root. Linked-worktree workspaces are never selected as the launch
destination. Running sessions are focused wherever they already live. The
launcher waits for every new root pane's shell before starting the agent.

New sessions created from full GitHub URLs use compact names such as
`issue-1158`, `pull-99`, and `discussion-12`. Bare numbers use the number itself.
Ordinary text is preserved exactly as the native session name. Pi receives the
GitHub URL through `pi-gh-context` without submitting a model prompt; the URL is
persisted, left in the editor, and shown as a clickable widget above it. Other harnesses
continue to receive the configured discussion prompt.

## Configuration

On first run, the plugin copies `config.example.json` into its Herdr plugin
config directory as `config.json`:

```sh
herdr plugin config-dir ogulcancelik.github-start
```

```json
{
  "defaultAgent": "pi",
  "projectRepoName": "herdr",
  "agents": {
    "codex": { "renameCommand": "/rename {sessionName}" }
  },
  "githubSessionNameTemplate": "{nameKind}-{number}",
  "promptTemplate": "see {url}, lets discuss the problem,shape,kiss fix",
  "tabLabelTemplate": "{sessionName}",
  "timing": {
    "agentStartTimeoutMs": 30000,
    "sessionNameTimeoutMs": 5000,
    "shellReadyTimeoutMs": 5000
  }
}
```

Templates can use `{url}`, `{raw}`, `{repo}`, `{repoName}`, `{kind}`, `{nameKind}`,
`{number}`, `{sessionName}`, and `{sessionId}`. `nameKind` maps GitHub's `pr` route
to `pull`. `projectRepoName` identifies the destination through Herdr's workspace metadata;
the matching main-checkout workspace must be open. The default harness and Codex
rename command are configurable. Pi and Claude Code are named through their
native `--name` startup flags.

## Requirements

Requires Herdr 0.7.5 or newer and Node.js 18 or newer. Pi URL handoff requires
the `pi-gh-context` extension. Pi starts normally through `herdr pane run`, so
Herdr detects it without assigning a managed agent name. Other harnesses use
`herdr agent start`; matching live sessions use `agent focus`. The plugin creates
only the selected agent tab and does not add a viewer split.
