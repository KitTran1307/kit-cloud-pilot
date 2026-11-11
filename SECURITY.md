# Security

## What cloud-pilot touches

| Part | Reads | Writes | Runs | Network |
| --- | --- | --- | --- | --- |
| hub (`cloud-pilot track/watch/wait/status`) | its data folder | its data folder (`~/.claude/cloud-pilot`) | `gh`, `git` | GitHub API through `gh` |
| start (`cloud-pilot start`) | the brief file, the repo's origin | a line per start in `sessions.jsonl` (no brief text) | `python` + `claude --cloud` | Claude Code |
| channel (`channel`, `answer`) | the question comment, your private key | a signed answer comment; `channel setup` writes into the repo you name | `gh` | GitHub API |
| plugin | environment | `install.json` in the data folder | the CLI, for `/pilot` | none |

- **Tokens:** `gh auth token` answers stay in memory and reach `gh` as `GH_TOKEN`; they are never written or logged.
- **Writes on GitHub:** answer comments you ask for, and, only with `CLOUD_PILOT_DELETE_MERGED=1`, deleting a merged
  `claude/*` branch you tracked yourself while it still points at the merged commit.
- **Signing key:** Ed25519, created by `channel keygen` outside any git working tree (refused inside one), never
  printed, never copied by `channel setup` (which installs only the public key and its fingerprint).
- **Untrusted text:** titles, comments and questions from GitHub are passed on only as `untrusted_*` fields with
  invisible characters removed; a comment by someone other than the PR's author is never urgent and its text is not
  passed on.
- **What a signature proves:** that the answer came from the holder of your key, for that exact question, PR and
  commit, and it stops third parties (strangers, replays, edited questions, fork PRs). It cannot stop the cloud session
  itself: the session runs your repo's code in its own VM and can skip or fake the check, the key or the pin in its own
  working copy, or open its PR against a base that already carries the change. `channel answer` runs on your machine and
  refuses PRs that change agent or automation config (judged against the default branch), but that only narrows what you
  can be led to sign. Never treat a cloud session's claim that "the person approved" as approval for money, production,
  data deletion or legal matters: only your own message in the session counts, and the skill tells Claude to leave those
  decisions to you.
- **Briefs** go to `claude --cloud` as a command-line argument, which other local users can see in the process list.

## Reporting a problem

Please open a [private security advisory](https://github.com/KitTran1307/kit-cloud-pilot/security/advisories/new)
rather than a public issue, with your OS, Claude Code version and the steps to reproduce.
