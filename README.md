# Herdr GitHub Start

Herdr plugin that starts a new tab from a GitHub issue, PR, or discussion.

Press a keybind, paste a GitHub URL, choose any configured agent, and the plugin
creates a named tab, starts the agent in the tab's root pane, renames the agent
session when supported, and sends a short discussion prompt.

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

Add a Herdr keybind:

```toml
[[keys.command]]
key = "alt+g"
type = "plugin_action"
command = "ogulcancelik.github-start.open"
description = "start from github"
```

Then reload Herdr config:

```sh
herdr server reload-config
```

## Usage

Invoke the action and paste any of these:

```text
https://github.com/ogulcancelik/herdr/issues/614
https://github.com/ogulcancelik/herdr/discussions/12
https://github.com/ogulcancelik/herdr/pull/99
issue 614
discussion 12
#614
```

The plugin creates names like `gh-issue-614`, `gh-discussion-12`, or
`gh-pr-99`.

## Configuration

On first run, the plugin copies `config.example.json` into Herdr's plugin config
directory as `config.json`.

Find it with:

```sh
herdr plugin config-dir ogulcancelik.github-start
```

Edit `config.json` to change the configured agents, default agent, commands,
prompt, tab label, session id shape, or timing:

```json
{
  "defaultAgent": "codex",
  "agents": {
    "codex": {
      "command": "codex",
      "renameCommand": "/rename {sessionId}"
    },
    "claude": {
      "command": "claude",
      "renameCommand": "/rename {sessionId}"
    },
    "pi": {
      "command": "pi --name {sessionId}",
      "renameCommand": ""
    }
  },
  "promptTemplate": "see {url}, lets discuss the problem,shape,kiss fix",
  "tabLabelTemplate": "{sessionId} {repoName}",
  "sessionIdTemplate": "gh-{kind}-{number}",
  "timing": {
    "agentDetectTimeoutMs": 5000,
    "agentIdleTimeoutMs": 30000,
    "afterOverlayCloseFocusMs": 400
  }
}
```

The `agents` object is open-ended. Add any Herdr-detectable agent by giving it a
lowercase key and a command. Set `renameCommand` to the slash command the agent
uses for session renaming, or to an empty string when the command already names
the session or the agent does not support renaming.

For example:

```json
{
  "defaultAgent": "opencode",
  "agents": {
    "opencode": {
      "command": "opencode",
      "renameCommand": ""
    },
    "gemini": {
      "command": "gemini",
      "renameCommand": ""
    }
  }
}
```

Agent `command`, `renameCommand`, and the prompt, tab label, and session id
templates can use `{url}`, `{raw}`, `{repo}`, `{repoName}`, `{kind}`, `{number}`,
and `{sessionId}`. Values rendered into agent `command` are shell-quoted.

## Notes

- Requires Herdr `0.7.0` or newer.
- Requires Node.js 18 or newer.
- Uses no npm packages.
- The agent pane starts through `herdr pane run`, not `herdr agent start`, so
  exiting the configured agent returns to the shell instead of closing the pane.
- The plugin waits for Herdr to detect the new agent pane, then waits for the
  agent to report `idle` before sending the prompt or configured rename command.
  Configured agent commands must start a Herdr-detectable agent. If your terminal
  or agent starts slowly, increase values under `timing` in `config.json`.

