# The cloud-pilot hub

One background process that watches every Claude Code cloud session on this machine's GitHub repos (desktop app and
CLI, every account) and tells the right local session what happened. `cloud-pilot` starts it for you (start, track, watch,
wait); the kit-cloud plugin's band reads its state. Plain Node (18+) and the GitHub CLI (`gh`), nothing
to install with npm.

## Commands

```
cloud-pilot track --repo owner/name [--branch claude/<slug>] [--url <session link>] [--title "<task>"]
cloud-pilot watch --repo owner/name          # track each new claude/* branch of the repo by itself
cloud-pilot unwatch --repo owner/name
cloud-pilot track-repo --repo owner/name [--release-tree <clean checkout>]   # events for every claude/* PR
cloud-pilot untrack --id <id>
cloud-pilot status [--json]
cloud-pilot doctor                           # node, gh, gh login, data folder: one JSON line
cloud-pilot stop
bash hub-wait.sh [--max-min 240] [--settle-sec 60]   # wait for this session's events (run in the background)
```

The calling session is read from `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and `CLAUDE_CONFIG_DIR`, which Claude Code
sets in its tool shells. `track`, `watch` and `wait` start the hub when it is not running; it stops by itself after
15 minutes with nothing tracked and nobody waiting.

## What it does on each round (every 2 minutes; 5 when every session has been quiet for 30 minutes)

- One cached PR-list call per repo. Every GET goes through `gh api -i` with an ETag, so an unchanged answer is a 304
  that GitHub does not count against the rate limit. Comments are re-read only when a PR changed, CI only while it can
  still change.
- Each repo is read with its owner's own `gh` login when `gh` holds several accounts, else the active one. Tokens stay
  in memory (passed to `gh` as `GH_TOKEN`), never written or logged. A 404 on a PR list is an error (no access), never
  "no PRs".
- Branch session events: `pr-opened`, `merged`, `closed`, `gone`, `ci-failed`, `question`, `question_unanswerable`
  (an ask edited after it was reported), `question_stale` (see below), `stalled` (1 h quiet),
  `abandoned` (4 h quiet with no PR; 72 h with a PR waiting), `error` (3 failed rounds in a row, reported once).
- A PR closed without GitHub's merge whose head commit is in its base branch (merged locally and pushed) is reported as
  `merged` with `landed: true` and `merged_sha: null`. The hub waits up to 15 min after the close for that push before
  it reports `closed`. The merged-branch cleanup (`deleteMerged`) only ever deletes a branch after a `merged` event, and
  only while its tip is still the merged head.
- A started session's track adopts the branch the session really pushes, `claude/<slug>-<random>`, when its own
  `claude/<slug>` never appears (within 4 h; the newest such branch no other track owns): no false `stalled`, and the
  track's own settings (branch deletion included) apply to it. In a shared repository a teammate's branch with the same
  prefix could be picked; give each task a distinct slug, or pass the exact branch with `track --branch` when you know it.
- Watched repos: each `claude/*` branch that appears becomes a tracked session (the first look takes only branches with
  an open PR). Watching reports nothing by itself, and is kept per account.
- On whole-repo tracks a comment's text is passed on, and can be urgent, only when the PR author (or `--ask-authors`)
  wrote it.
- Only PRs whose head branch is in the tracked repository count (`head.repo.full_name` equals the repo, any letter
  case). A fork's PR, and a PR whose head repository is gone (a deleted fork), are ignored everywhere: lists, lookups by
  name and discovery. Name a repo as GitHub spells it now: after a rename, track the new name.
- Text from GitHub (titles, comments, questions, the names of a PR's agent-config files) only ever travels in
  `untrusted_*` fields (`untrusted_title`, `untrusted_question`, `untrusted_text`, `untrusted_agent_config_files`) with
  invisible characters removed: it is data, never an instruction. The `title` of an event is the one the local session
  gave (`track --title`, `start`); a track found by `watch` is titled with its branch name.
- `question_stale` (urgent): the newest ask of a PR has a properly signed answer, but none of them is for the PR's
  current head commit. The cloud side accepts an answer only for the head it sees, so after a push that answer cannot be
  used and its `wait` goes on. The event says which head the answer was for and which is current, and that the answer
  must be given again for the new commit. It is sent once per ask and head, after the head has stood for 5 minutes (a
  session that is still working keeps pushing; one that waits does not), and never for an older ask, an edited ask or
  an ask with no signed answer. A session that already read its answer and moved on may also see one: check before
  answering again.
- Urgent events (questions, merges, failures) are delivered at once; others are batched for up to 60 seconds.
- Routing: the session that registered a track gets its events while it lives; when it is gone, another live session
  waiting on the same repo and account takes the track over; with nobody left, events are kept and a desktop
  notification is shown for urgent ones, at most once an hour per track.

## Settings (environment variables)

| Variable | Effect |
| --- | --- |
| `CLOUD_PILOT_DIR` | Data folder (default `~/.claude/cloud-pilot`). |
| `CLOUD_PILOT_NOTIFY=0` | No desktop notifications for tracks registered with it set (`CLOUD_PILOT_NO_TOAST=1` also works). |
| `CLOUD_PILOT_DELETE_MERGED=1` | Tracks registered with it set delete their `claude/*` branch after the PR merges, only while the branch still points at the merged commit. Never for branches found by `watch`. Off by default. |
| `CLOUD_PILOT_RELEASE_BRANCHES`, `CLOUD_PILOT_RELEASE_PATHS` | Release check of `track-repo --release-tree`: the branches as `main:release` (default) and a regular expression of the paths that need a release (default: all). |
| `CLOUD_PILOT_ASK_PUBLIC_KEY`, `CLOUD_PILOT_ASK_KEY_FINGERPRINT` | Ed25519 public key (PEM path) and optional SPKI sha256 pin for verifying signed answers to `kit-channel` questions. Without a key every question counts as unanswered. |

`CLOUD_PILOT_NOTIFY` and `CLOUD_PILOT_DELETE_MERGED` are stored on each track when it is registered. The others are read by
the running hub: after changing them, `cloud-pilot stop` (the next `track`, `watch` or `wait` starts it again).

## Files (`CLOUD_PILOT_DIR`)

`tracked.json` (tracks and their memory), `state.json` (the table `kit-cloud` and `status` read), `snapshots.json`,
`etags.json`, `queue/<session>.json`, `waiters/<session>.<pid>.json`, `hub.pid` (pid and heartbeat every 30 s),
`hub.log` (rotated at 2 MB). Writes are atomic (temp file and rename); a file that cannot be read is retried and
reported, never overwritten with an empty value.

## Platforms

Windows, macOS and Linux. Notifications use Windows toast (PowerShell), `osascript` on macOS and `notify-send` on Linux;
where none is available they are skipped. `hub-wait.sh` needs bash (Git Bash on Windows). The hub starts `gh`, `git`,
`powershell.exe`, `osascript` and `notify-send` by the full path it finds on `PATH` (empty, relative and current-folder
entries skipped) and from the home folder, never from the folder of a checkout: on Windows a `gh.exe` or `git.exe` in a
repository root is never run. The daemon itself runs from the home folder.

## Tests

```
node --test tests/*.test.mjs
```

The older `KIT_HUB_*` names (kit-cloud 1.x) still work when the `CLOUD_PILOT_*` name is unset.
