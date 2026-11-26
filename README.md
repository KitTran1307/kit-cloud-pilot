# kit-cloud-pilot

[![CI](https://github.com/KitTran1307/kit-cloud-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/KitTran1307/kit-cloud-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Windows · macOS · Linux](https://img.shields.io/badge/os-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555.svg)](#)

**Let Claude Code (CLI) run work in Claude Code cloud sessions by itself:** start them, track them on GitHub, wait for
what they need, and answer their questions with a signed reply. Your local Claude session hands off the long work,
keeps your machine free, and is woken when a cloud session opens a pull request, fails CI, goes quiet or asks you
something.

```
you ──► local Claude (CLI) ──cloud-pilot start──► cloud session ──► claude/<branch> + pull request on GitHub
              ▲                                                            │
              └──────── cloud-pilot wait ◄── hub (one process, polls GitHub, cached) ◄──┘
                         events: pr-opened · ci-failed · conflict · question · merged · stalled ...
```

Want to *see* the sessions above the prompt? Add the optional band,
**[kit-cloud](https://github.com/KitTran1307/kit-claude-mods/tree/main/plugins/kit-cloud)**:

![kit-cloud's band above the prompt, showing cloud sessions tracked by cloud-pilot](https://raw.githubusercontent.com/KitTran1307/kit-claude-mods/main/docs/images/terminal-bands.png)

## Requirements

- Claude Code CLI with cloud sessions (`claude --cloud`) on your plan.
- **Node.js 18+** and the **GitHub CLI** `gh`, signed in (`gh auth login`) with access to your repos.
- **A terminal for `claude --cloud`**, which `cloud-pilot start` provides by itself. On Windows 10 1809 or later it uses
  Windows' own pseudo-console (ConPTY) through the built-in Windows PowerShell: nothing to install. On macOS and Linux
  it uses Python 3, which they ship with. Python with `pywinpty` stays a fallback on Windows where ConPTY is unavailable.
- Windows, macOS or Linux.

## Install

As a Claude Code plugin (recommended: Claude then knows the command and when to use it):

```
/plugin install kit-cloud-pilot --marketplace KitTran1307/kit-cloud-pilot
```

or from a shell `claude plugin install kit-cloud-pilot --marketplace KitTran1307/kit-cloud-pilot`. It is also listed in
the [kit-claude-mods](https://github.com/KitTran1307/kit-claude-mods) marketplace, and installing kit-cloud there
installs it too. Then check: `/pilot doctor`.

Or ask Claude: *"Install the kit-cloud-pilot plugin from the KitTran1307/kit-cloud-pilot marketplace and run its doctor."*

Without the plugin, the command works on its own: clone this repo and run `node bin/cloud-pilot.mjs help`.

## Use

Ask Claude to do something big "in the cloud" (or let it decide: the plugin's skill says when cloud fits). Claude
writes a brief and runs:

```
cloud-pilot start --cwd <repo> --brief-file brief.md      # starts the session and tracks it; prints its link
cloud-pilot wait                                         # in the background: returns when something needs you
```

| Command | What it does |
| --- | --- |
| `start --brief-file <f> [--cwd] [--branch claude/x] [--environment env_…]` | Start a cloud session (in the cloud environment you name, else the account's default) and track it ([start/README.md](start/README.md)) |
| `track --repo o/n [--branch] [--url] [--title]` | Track a session started elsewhere (web, desktop app) |
| `watch --repo o/n` / `unwatch` | Track every new `claude/*` branch of a repo by itself |
| `wait [--max-min 240]` | Wait for this session's events; one JSON line |
| `status [--json]`, `untrack --id`, `stop`, `doctor` | What is tracked; stop tracking; stop the hub; check the machine |
| `channel setup <repo> --write`, `channel keygen` | Let a repo's cloud sessions ask you questions ([channel/README.md](channel/README.md)) |
| `nudge --id <trackId>` or `--repo o/n --pr N` `[--text]` | Send a message to a tracked cloud session now (default: a status check); prints `{sent, session_url, reason}` |
| `questions --repo --pr [--all]` | List a PR's open questions with the `question_sha256` that `answer` needs |
| `answer --repo --pr --id --question-sha256 --answer` | Answer a question with a signed comment, then tell the session that asked to read it |

In a session, `/pilot` shows what is tracked, `/pilot doctor` checks the machine.

When a tracked pull request fails CI or has merge conflicts with its base branch (event `conflict`), the hub tells the
cloud session that made it, once or twice per commit, to fix it and push (not merge). Nothing to set up; turn it off
with `CLOUD_PILOT_AUTOFIX=0`. The event says whether that notice went out (`autofix.sent`), so your local session
knows whether to step in.

### Alerts on your phone

Off by default: you get nothing unless you set one of these. You are told when a session asks a question, CI fails,
a pull request has conflicts, nothing was pushed, a PR merges or a track is abandoned (`CLOUD_PILOT_NOTIFY_KINDS`
changes the list).

```
# your own script (it gets CLOUD_PILOT_EVENT_KIND, _REPO, _BRANCH, _PR, _URL and _URGENT as environment variables)
CLOUD_PILOT_NOTIFY_CMD=~/bin/tell-me.sh

# or the built-in ntfy (https://ntfy.sh) for people with no script
CLOUD_PILOT_NTFY_TOPIC=pick-20-or-more-random-characters-here
```

Set them in the `env` block of `~/.claude/settings.json`. The hub reads them when it starts, so after a change run
`cloud-pilot stop`; the next `wait` starts it again. An alert carries only the kind, repository, branch, PR number and
a link, never a PR title or any text written on GitHub. **On the public ntfy.sh anyone who knows or guesses the topic
name can read what is posted to it** (repository name, PR number, link): use a long random topic or run your own ntfy
server (`CLOUD_PILOT_NTFY_URL`). No sign-in or token is used.

## Settings

Environment variables (for example in the `env` block of `~/.claude/settings.json`):

| Variable | Effect |
| --- | --- |
| `CLOUD_PILOT_DIR` | Data folder (default `~/.claude/cloud-pilot`) |
| `CLOUD_PILOT_LOCAL_ONLY` | Comma list of accounts that never start cloud sessions (`default` = `~/.claude`, `work` = `~/.claude-work`) |
| `CLOUD_PILOT_NOTIFY=0` | No desktop notifications (does not affect the alerts below) |
| `CLOUD_PILOT_NOTIFY_CMD` | A command of your own the hub runs for each alert event (see above); not waited for, stopped after 15 s, failures only go to `hub.log` |
| `CLOUD_PILOT_NOTIFY_KINDS` | Event kinds that alert (default `question,question_stale,question_waiting,ci-failed,conflict,no-push,merged,abandoned`) |
| `CLOUD_PILOT_NTFY_TOPIC`, `CLOUD_PILOT_NTFY_URL` | Send alerts to an ntfy topic (letters, digits, `-`, `_`, up to 64); server default `https://ntfy.sh` (`http` or `https`) |
| `CLOUD_PILOT_AUTOFIX=0` | The hub does not tell a session to fix its own failed CI or merge conflict |
| `CLOUD_PILOT_DELETE_MERGED=1` | Delete a tracked `claude/*` branch after its PR merges (only while it still points at the merged commit; never branches found by `watch`) |
| `CLOUD_PILOT_NO_PUSH_MIN` | Minutes a started session may go without pushing before `no-push` sets its account aside (5-120, default 20) |
| `CLOUD_PILOT_KEY_DIR`, `CLOUD_PILOT_PRIVATE_KEY` | Where the question channel's signing key lives (default `~/.cloud-pilot/keys`), or an existing key file |
| `CLOUD_PILOT_ASK_PUBLIC_KEY`, `CLOUD_PILOT_ASK_KEY_FINGERPRINT` | Public key (and pin) the hub uses to tell answered questions from open ones |
| `CLOUD_PILOT_CLAUDE_BIN` | The `claude` executable, when it is not on `PATH` |
| `CLOUD_PILOT_NUDGE=0` | `answer` does not tell the cloud session that asked to read its answer (`claude -p … --cloud <session>`) |
| `CLOUD_PILOT_PERMISSION_MODE` | Permission mode `start` gives new cloud sessions: `auto`, `acceptEdits` or `plan` (`--permission-mode` overrides it). Cloud sessions have no bypass mode |
| `CLOUD_PILOT_MODEL`, `CLOUD_PILOT_EFFORT` | Lead model and effort `start` gives new cloud sessions (`--model`, `--effort` override them); unset, the account's default model |
| `CLOUD_PILOT_DENY_MODELS` | Comma list of words a cloud session's model must not contain (`opus,fable`); with it set, `start` requires a model |
| `CLOUD_PILOT_RELEASE_BRANCHES`, `CLOUD_PILOT_RELEASE_PATHS` | Release check of `track-repo --release-tree` |

The older `KIT_HUB_*` names (from kit-cloud 1.x) still work. More in [hub/README.md](hub/README.md).

## Privacy and safety

- Everything runs on your machine with your own `gh` login; nothing is sent anywhere but GitHub and Claude Code.
- Text from GitHub (titles, comments, questions) is passed to Claude only as marked untrusted data.
- The signing key never leaves your machine and is refused inside any git repository. See [SECURITY.md](SECURITY.md).
- Briefs are passed to `claude --cloud` as an argument (visible in the process list): keep secrets out of them.

## Feedback

If cloud-pilot saves you time, a ⭐ on this repository helps other Claude Code users find it.

Bugs and ideas: open an [issue](https://github.com/KitTran1307/kit-cloud-pilot/issues/new/choose) (a form guides you).
Questions and how you use it: [Discussions](https://github.com/KitTran1307/kit-cloud-pilot/discussions). Security
problems: [SECURITY.md](SECURITY.md), not a public issue.

## Development

```
node --test hub/tests/*.test.mjs start/tests/*.test.mjs channel/tests/*.test.mjs bin/*.test.mjs
claude plugin test .
```

## License

[MIT](LICENSE)
