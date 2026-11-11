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
                         events: pr-opened · ci-failed · question · merged · stalled ...
```

Want to *see* the sessions above the prompt? Add the optional band,
**[kit-cloud](https://github.com/KitTran1307/kit-claude-mods/tree/main/plugins/kit-cloud)**:

![kit-cloud's band above the prompt, showing cloud sessions tracked by cloud-pilot](https://raw.githubusercontent.com/KitTran1307/kit-claude-mods/main/docs/images/terminal-bands.png)

## Requirements

- Claude Code CLI with cloud sessions (`claude --cloud`) on your plan.
- **Node.js 18+** and the **GitHub CLI** `gh`, signed in (`gh auth login`) with access to your repos.
- **Python 3** for `cloud-pilot start` (it gives `claude --cloud` the terminal it insists on). On Windows it sets up
  `pywinpty` in its own virtual environment on first use; macOS and Linux need nothing extra.
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
| `start --brief-file <f> [--cwd] [--branch claude/x]` | Start a cloud session and track it ([start/README.md](start/README.md)) |
| `track --repo o/n [--branch] [--url] [--title]` | Track a session started elsewhere (web, desktop app) |
| `watch --repo o/n` / `unwatch` | Track every new `claude/*` branch of a repo by itself |
| `wait [--max-min 240]` | Wait for this session's events; one JSON line |
| `status [--json]`, `untrack --id`, `stop`, `doctor` | What is tracked; stop tracking; stop the hub; check the machine |
| `channel setup <repo> --write`, `channel keygen` | Let a repo's cloud sessions ask you questions ([channel/README.md](channel/README.md)) |
| `questions --repo --pr [--all]` | List a PR's open questions with the `question_sha256` that `answer` needs |
| `answer --repo --pr --id --question-sha256 --answer` | Answer a question with a signed comment |

In a session, `/pilot` shows what is tracked, `/pilot doctor` checks the machine.

## Settings

Environment variables (for example in the `env` block of `~/.claude/settings.json`):

| Variable | Effect |
| --- | --- |
| `CLOUD_PILOT_DIR` | Data folder (default `~/.claude/cloud-pilot`) |
| `CLOUD_PILOT_LOCAL_ONLY` | Comma list of accounts that never start cloud sessions (`default` = `~/.claude`, `work` = `~/.claude-work`) |
| `CLOUD_PILOT_NOTIFY=0` | No desktop notifications |
| `CLOUD_PILOT_DELETE_MERGED=1` | Delete a tracked `claude/*` branch after its PR merges (only while it still points at the merged commit; never branches found by `watch`) |
| `CLOUD_PILOT_KEY_DIR`, `CLOUD_PILOT_PRIVATE_KEY` | Where the question channel's signing key lives (default `~/.cloud-pilot/keys`), or an existing key file |
| `CLOUD_PILOT_ASK_PUBLIC_KEY`, `CLOUD_PILOT_ASK_KEY_FINGERPRINT` | Public key (and pin) the hub uses to tell answered questions from open ones |
| `CLOUD_PILOT_CLAUDE_BIN` | The `claude` executable, when it is not on `PATH` |
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

## Development

```
node --test hub/tests/*.test.mjs start/tests/*.test.mjs channel/tests/*.test.mjs bin/*.test.mjs
claude plugin test .
```

## License

[MIT](LICENSE)
