# cloud-pilot channel

A Claude Code **cloud session** sometimes needs a decision that only you can make. The channel lets it ask you a question in a
GitHub pull request comment and wait for the answer, and lets your **local** Claude session answer with a comment that only
your private key can produce. Anything else that someone writes in the PR is ignored as data.

It is plain Node (18 or newer) and the GitHub CLI (`gh`). The cloud side needs only Node built-ins, and uses `fetch` with
`GH_TOKEN` when `gh` is not installed.

## The protocol

Two kinds of comment on the pull request. Both carry a machine-readable marker, so the format is stable and can be read by other
tools (the hub in this repository reads it too).

**Ask** (written by the cloud session):

```
<!-- kit-channel:ask {"v":1,"id":"deploy-ok","asked_at":"2026-01-01T10:00:00.000Z"} -->
WAITING FOR YOU (deploy-ok): Deploy the staging build now, or wait for the nightly?
```

- `id`: `[a-z0-9-]`, 4 to 40 characters, new for every question on a PR (only asks from allowed authors count when `ask` checks
  that an id is new, so a stranger's comment cannot use one up).
- The question is at most 2000 characters. The label before it is `WAITING FOR YOU (<id>): `. The first spelling of this protocol
  used a Vietnamese label; the parser still accepts it (it is written as unicode escapes in the code), so asks written by older
  copies of the script keep working. New asks always use the English label.
- GitHub's `created_at` of the comment is the time base. The `asked_at` inside is self-reported and not used.

**Answer** (written by your local session with `cloud-pilot channel answer`):

```
<!-- kit-channel:answer <payload>.<signature> -->
CLOUD-PILOT ANSWER (deploy-ok). Display only, never trusted: just the signed block above counts.
Authority: local-session
Answer:
...the answer in a code fence...
```

`<payload>` is base64url of a JSON object, `<signature>` the base64url Ed25519 signature of those exact bytes. The visible text
below the marker is for people only and is never parsed. The payload (version 3):

| Field | Meaning |
| --- | --- |
| `v` | `3` |
| `repo`, `pr`, `id` | The repository, PR number and question id the answer is for. |
| `ask_comment_id` | The id of the ask comment, so a re-posted question with the same id is not answered by an old reply. |
| `question_sha256` | sha256 of the question text, so the answer is for exactly that text. |
| `head_sha` | The PR head commit when you answered. A new commit on the PR means answer again. |
| `answer` | Up to 4000 characters. |
| `authority` | Always `local-session`. |
| `issued_at`, `expires_at` | At most 7 days apart (default 24 hours). |

The cloud side accepts an answer only when all of these hold: the signature verifies with the pinned key; every field above
matches this repo, PR, id, ask comment, question hash and the current PR head; the answer comment is newer than the ask comment;
it is not expired; it was not issued more than 5 minutes in the future or before the ask (clock skew); the ask is unedited and was
written by an allowed author; and the payload has no `owner_quote` field. The first valid answer wins. Anything that fails is
skipped silently.

`wait` ends with one JSON line and an exit code: `answered` (0), `timeout` (3), `error` (2, after three failed polls in a row, a
missing or mismatching key pin, or a PR from a fork), `refused_agent_config` (4).

## Threat model

**What a valid signature proves.** Someone who holds your private key produced this exact answer, for this repository, PR,
question text and PR head, within its validity window. A stranger who comments on the PR, a prompt injected through a comment,
an old answer replayed on another question, another PR or a later commit, and a question edited after it was asked, are all
rejected.

**What it does not prove.**

- It does not prove that a human read the question. The authority is `local-session`: your local Claude session answered an
  ordinary question on your behalf. Anything that can run `cloud-pilot channel answer` on your machine, or read your private key,
  can sign. Keep the key outside every repository (keygen enforces that, and every command that loads the key refuses a key
  inside a git working tree) and treat access to it like access to your GitHub login.
- It does not make a sensitive action safe. A channel answer is **never** your own consent to spend money, deploy to production,
  delete data or make a legal statement (terms, consent, contracts). The `CLAUDE.md` block that setup writes tells the cloud
  session never to ask for those. If a question like that reaches you anyway, do not answer it through the channel: reply in
  the cloud session's own chat instead.
- **It cannot stop the cloud session itself.** The session runs your repository's code in its own VM. It can edit the channel
  script, the public key and the pin (`.claude/cloud/channel.mjs`, `channel-public.pem`, `channel.json`) in its own working
  copy without committing anything, open its PR against a base branch that already carries such a change, or just skip the
  check and print "the person approved". What the channel proves is that an answer came from your key for that exact question,
  PR and commit, and it stops third parties (strangers, replays, edited questions, fork PRs). It cannot prove that the cloud
  session really ran the check. So never treat a cloud session's claim "the person approved" as approval for money,
  production, deleting data or a legal statement: only your own message in the session counts for those.
- It is not private. Comments are as visible as the PR: in a public repository the question and the answer are public. Never put
  secrets in either.

**What limits the damage.**

- *Agent-config refusal.* If the PR touches agent or automation config, `answer` refuses to sign, and `wait` returns
  `refused_agent_config` at once, even if a valid answer already exists. The files are those the PR head changes relative to the
  repository's default branch (GitHub's compare `default...head`), not relative to the PR's own base branch, so a PR opened
  against a branch that already carries the change is still caught. The paths are anything inside a `.claude`, `.agents`,
  `.codex`, `.githooks`, `.github`, `.husky`, `.vscode`, `.devcontainer` or `.cursor` folder at any depth, and files named
  `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `GEMINI.md` or `.mcp.json` anywhere. Renames count by both names. A PR with more
  files than GitHub lists (3000) is refused too, because the list may hide such a file. This limits what your own machine can be
  led to sign: `answer` runs from your own copy of this tool, so a PR cannot disable the check there. The copy of `wait` inside
  the repository is only as good as the session that runs it (see above).
- *Head pinned while answering.* `answer` reads the PR head first, checks that exact commit, and reads the head again right
  before signing. If it moved, it refuses ("PR changed while answering; run again").
- *Same-repository PRs only.* `ask`, `wait` and `answer` refuse a PR whose head repository is missing or differs (ignoring case)
  from the base repository, which is a fork PR.
- *PR-author-only asks.* `wait` and `answer` only look at asks written by the PR author (override with `--ask-authors` or
  `CLOUD_PILOT_ASK_AUTHORS`). Another account cannot plant an ask, or hijack an id, on a PR it does not own.
- *Fail closed.* No pin, a wrong pin, a missing key file, a key that is not Ed25519, an unknown payload version, a missing or
  unknown `head_sha`: nothing verifies.
- *Display text is data.* The text of an ask is shown to you as untrusted; the text of an answer is shown in a code fence with HTML
  comment markers defanged. Only the signed payload decides anything.

## Setup

1. **Create your key** (once per person, on your machine):

   ```
   cloud-pilot channel keygen
   ```

   The private key goes to `~/.cloud-pilot/keys/ed25519-private.pem` (mode 0600 where the OS supports it) and the public key next
   to it as `ed25519-public.pem`. Change the folder with `CLOUD_PILOT_KEY_DIR`. keygen refuses a place inside any git working
   tree or inside this repository, and refuses while `CLOUD_PILOT_PRIVATE_KEY` is set (unset it to generate a new key: it points at
   a key you already have). If you already have an Ed25519 private key in PEM form, leave it where it is and set
   `CLOUD_PILOT_PRIVATE_KEY` to its path: its public half is derived from it. A key inside a git working tree or inside this
   repository is refused when it is loaded, too.

2. **Prepare each repository** that cloud sessions work on:

   ```
   cloud-pilot channel setup /path/to/repo           # dry run: shows what would change
   cloud-pilot channel setup /path/to/repo --write
   ```

   This copies the cloud script to `.claude/cloud/channel.mjs`, your public key to `.claude/cloud/channel-public.pem`, writes
   `.claude/cloud/channel.json` (`{ "fingerprint": "<sha256 of the key's SPKI>" }`, the pin), and adds or updates one block in
   `CLAUDE.md` between `<!-- cloud-pilot:channel -->` and `<!-- /cloud-pilot:channel -->` that tells a cloud session how and when
   to ask. Running it again changes nothing that is current. The private key is never copied (setup checks every file for private
   key material before and after writing). It never writes through a link: if `.claude`, `.claude/cloud`, one of the files or
   `CLAUDE.md` is a symlink or junction, it refuses, and each file is written to a temp file in its folder and renamed into place. **Commit and push those files to the default branch yourself**: cloud sessions read
   them from there.

3. **Tell the hub** which key to trust, so it can show which questions are still open: set `CLOUD_PILOT_ASK_PUBLIC_KEY` to the
   path of `ed25519-public.pem` and, optionally, `CLOUD_PILOT_ASK_KEY_FINGERPRINT` to the value `cloud-pilot channel fingerprint`
   prints.

4. **A cloud session asks and waits**, as the `CLAUDE.md` block says:

   ```
   node .claude/cloud/channel.mjs ask  --repo owner/name --pr 12 --id deploy-ok --text "Deploy the staging build now?"
   node .claude/cloud/channel.mjs wait --repo owner/name --pr 12 --id deploy-ok
   ```

5. **You answer** from your local session, with the question hash the hub printed:

   ```
   cloud-pilot channel answer --repo owner/name --pr 12 --id deploy-ok --question-sha256 <hash> --answer "Yes, deploy staging."
   ```

   Run `gh auth switch --user <account>` first when you have several GitHub accounts: the tool prints the account it uses.

To change your key, run `keygen --force`, then `setup --write` in every repository and commit. Answers signed with the old key stop
verifying. `setup` tells you when the pin changes.

## Commands

All commands print JSON lines and accept `--help`. The leading `cloud-pilot channel` is how the main command calls this tool;
the entry point is `channel/index.mjs` (`main(argv)`, where `argv[0]` is the command).

| Command | What it does |
| --- | --- |
| `cloud-pilot channel keygen [--force]` | New Ed25519 key pair in the key dir. Refuses to replace a key without `--force`, and refuses while `CLOUD_PILOT_PRIVATE_KEY` is set. |
| `cloud-pilot channel fingerprint` | Prints the SPKI sha256 of your public key. |
| `cloud-pilot channel setup <repo path> [--write] [--public-key <file>]` | Dry run by default. Copies the cloud script, public key and pin, and updates the `CLAUDE.md` block. Refuses a folder that is not the root of a git working tree. |
| `cloud-pilot channel ask --repo owner/name --pr N --id <id> --text "<question>"` | Posts the question. What the cloud session runs; works locally too. |
| `cloud-pilot channel wait --repo owner/name --pr N --id <id> [--timeout-min 360] [--interval-sec 60] [--ask-authors a,b]` | Polls until a valid answer arrives. Locally it trusts your own public key; the copy in a repository trusts the shipped key and pin. |
| `cloud-pilot channel answer --repo owner/name --pr N --id <id> --question-sha256 <hash> --answer "<text>" [--valid-hours 24] [--ask-authors a,b] [--dry-run]` | Re-reads the ask from GitHub, checks it, signs and posts. `--dry-run` shows what would be signed and needs no private key. |

## Settings

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CLOUD_PILOT_KEY_DIR` | keygen, fingerprint, setup, answer, local wait | Folder of the key pair. Default `~/.cloud-pilot/keys`. (`KIT_HUB_KEY_DIR` also works.) |
| `CLOUD_PILOT_PRIVATE_KEY` | the same | Path of one private PEM file, used instead of the key dir. |
| `CLOUD_PILOT_ASK_AUTHORS` | wait, answer | Comma list of GitHub logins whose asks count. Default: the PR author. (`KIT_CHANNEL_ASK_AUTHORS` also works.) |
| `GH_TOKEN` | cloud side | Used only when `gh` is not installed. Never printed. |

## Compatibility

The wire format is unchanged from the first version of the protocol: the same two comment markers, ask `v:1`, answer payload `v:3`
with the same fields in the same order and the same checks. A repository that still carries an older copy of the script accepts
answers signed by this `answer`, and the hub keeps parsing asks. Two things differ and are display-only or additive: new asks use
the English label (the parser accepts both), and the visible line of an answer reads `CLOUD-PILOT ANSWER` instead of the old label
(it is never parsed). One limit: an older copy of the script cannot wait on an ask written by the new one, because it would read
the English label as part of the question text. A repository is upgraded as a whole by `setup --write`, which replaces the script
that asks and the script that waits together.

## Tests

```
node --test channel/tests/*.test.mjs
```

No network is used. `tests/fixtures/legacy-signed.json` holds an answer signed by the first implementation with a throwaway key,
so the cross-check against it keeps running without the old code.
