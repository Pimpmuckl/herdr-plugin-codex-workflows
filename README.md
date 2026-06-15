# Herdr GitHub Start

Herdr plugin that starts a new tab from a GitHub issue, PR, or discussion.

Press a keybind, paste a GitHub URL, choose `codex` or `claude`, and the plugin
creates a named tab, starts the agent in the tab's root pane, renames the agent
session, and sends a short discussion prompt.

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

Edit `config.json` to change the default agent, commands, prompt, tab label,
session id shape, or timing:

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
    }
  },
  "promptTemplate": "see {url}, lets discuss the problem,shape,kiss fix",
  "tabLabelTemplate": "{sessionId} {repoName}",
  "sessionIdTemplate": "gh-{kind}-{number}"
}
```

Available template values include `{url}`, `{raw}`, `{repo}`, `{repoName}`,
`{kind}`, `{number}`, and `{sessionId}`.

## Notes

- Requires Herdr `0.7.0` or newer.
- Requires Node.js 18 or newer.
- Uses no npm packages.
- The agent pane starts through `herdr pane run`, not `herdr agent start`, so
  exiting Codex or Claude returns to the shell instead of closing the pane.
- The plugin sends slash commands after a short delay. If your terminal or agent
  starts slowly, increase values under `timing` in `config.json`.

