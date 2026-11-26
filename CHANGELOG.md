# Changelog

## 1.8.0

- **A question from a cloud session always reaches someone.** A question on a branch that a repository watch found
  (a session started from the desktop app or the web) now wakes the session watching that repository, like the
  sessions it started itself. Before, such a question could wait unread for a day.
- **Unanswered questions are told again.** `question_waiting` (urgent) comes 20 minutes after a question was first
  seen and then every hour, at most 8 times, until it has an answer; the person also gets a desktop notification each
  time (and a phone alert when alerts are on).
- **A session that stopped listening counts as gone.** A local session whose process still runs but that has left an
  urgent event unread for 15 minutes hands its tracks to another waiting session, or the person is told.
- **A question is never held back by the toast limit**: a notification shown for a conflict a minute earlier no
  longer hides the question that follows it.
- **Messages to sessions of the desktop app's account work.** A track of the account `default` sends with no
  `CLAUDE_CONFIG_DIR` instead of the hub's own; when an account answers "Session not found" or its login has
  expired, the other known accounts are tried, and a failed send says what to do (sign in again, or open the session).

## 1.7.0

- **Alerts on your phone, off by default.** Set `CLOUD_PILOT_NOTIFY_CMD` (a command of your own) or
  `CLOUD_PILOT_NTFY_TOPIC` (built-in ntfy) and the hub tells you when a session asks a question, CI fails, a PR has
  conflicts, nothing was pushed, a PR merges or a track is abandoned (`CLOUD_PILOT_NOTIFY_KINDS` picks the kinds). Only
  the kind, repository, branch, PR number and a link are sent, never GitHub text. The public ntfy.sh is readable by
  anyone who knows the topic: pick a long random one or self-host (`CLOUD_PILOT_NTFY_URL`).
- **New event `conflict`** (urgent): an open PR of a tracked branch has merge conflicts with its base. Once per commit.
- **Failed CI and conflicts go back to the session that made them.** The hub sends it one short notice (fix, run the
  checks, push, do not merge), at most twice per commit and kind. The event's `autofix` field says whether it was sent
  and, if not, why, so the local session knows when to step in. Off: `CLOUD_PILOT_AUTOFIX=0`.
- **`cloud-pilot nudge`** sends a message (by default a status check) to a tracked cloud session now.
- Self-handling stops by itself: at most 2 notices per commit, 4 per session in all, and none within 30 minutes
  of the last, so a check the session cannot fix never turns into a loop.
- Alerts carry only plain links (the query of a session link is dropped), so a shell command such as
  `curl %CLOUD_PILOT_EVENT_URL%` cannot be tricked into running more; on Windows a hung command is ended with its
  children and no console window opens.

## 1.6.1

- **Answers reach sessions started anywhere.** A cloud session that cloud-pilot did not start (the desktop app, the
  web, a plain `claude --cloud`) is now found through the session link Claude Code puts at the end of its pull
  request, and told to read its answer as the current account. One account or several, with or without
  `CLAUDE_CONFIG_DIR`, Remote Control on or off: the notice goes the same way.
- **Watching with a `Monitor` tool:** the skill runs `wait --max-min 25` under it, so the wait ends before the watch
  expires (about 30 minutes) and is started again, instead of going quiet.

## 1.6.0

- **Answers reach a cloud session that stopped looking.** A cloud session that asked a question and then ended its
  turn never read the PR again, so a posted answer could sit unread for hours. `cloud-pilot answer` now also tells
  the session that asked (found among the tracked sessions) to read it, with `claude -p "<notice>" --cloud <session>`
  as the account that started it (tracks registered from 1.6.0 on record it; older ones use the current account). The notice holds no answer and approves nothing: the session still acts only on the
  signed answer its own `wait` prints. The result is in the output's `nudge` field (with the `notice` to send by
  hand when it could not be sent); the answer never fails because of it. Off: `CLOUD_PILOT_NUDGE=0`.
- The skill says how to see what a silent session is doing (`RemoteTrigger`'s `get_run_log` with its session id)
  and that `claude -p … --cloud` is the dependable way to message one; Claude Code's own `SendMessage` reaches cloud
  sessions only while Remote Control is on.
- **Windows:** the hub waits longer (up to about 4 s) for a file a scanner holds before a state write fails.

## 1.5.1

- **Fix:** on macOS and Linux, `cloud-pilot start` failed when its data folder could not be read (1.5.0's check for
  accounts set aside). An unreadable folder never blocks a start again, as before 1.5.0.

## 1.5.0

- **No more cloud sessions where they cannot push.** When a started session pushes nothing (`no-push`), its account is
  set aside: `cloud-pilot start` refuses it, with what to do, instead of sending another session that cannot reach
  GitHub. It comes back by itself when a session of that account pushes after all, or when you reconnect GitHub
  (https://claude.ai/connect-github) and run `cloud-pilot account --ok <account>`. `cloud-pilot account` lists them.
- **Taking the work over locally:** `start` keeps a private copy of each brief (deleted with its track), and the
  `no-push` event names it (`brief_file`) with the account, so Claude can continue on your machine.
- `CLOUD_PILOT_NO_PUSH_MIN` (5-120, default 20) sets how long a started session may go without a push.

## 1.4.0

- **A session that pushes nothing is reported early.** A started session (one tracked with its link, as `start` does)
  that has no branch, commit or PR on GitHub 20 minutes after it started now gets one urgent `no-push` event, with the
  usual causes in its `note`: the account that started it lost its GitHub connection (reconnect GitHub on
  claude.ai/code, or run `/web-setup` in that account), the Claude GitHub App is missing on the repository, or the
  session waits on a question or a permission on its own page. Before, the first sign was `stalled` after an hour.
- **`cloud-pilot take`**: one look at this session's events, no waiting. The kit-cloud plugin (2.5.0) uses it to hand
  the events to Claude in that session by itself, so they no longer depend on a `wait` that Claude restarted after
  each batch. It takes only the events of sessions the caller registered; those of branches a watch found by itself
  stay for `wait`.
- The skill says to start `wait` again after every batch when kit-cloud is not installed.

## 1.3.2

- **The repository folder is recognized behind links too.** When a program is looked up on PATH, the current folder
  is now skipped even when PATH names it through a link (macOS `/var` is `/private/var`; a junction, symlink or
  `\\?\` path on Windows). 1.3.1 missed that case on macOS.

## 1.3.1

Security fixes from a full review. Update is recommended.

- **No program from the repository folder.** `answer`, `questions` and the `channel` commands started `gh` by its bare
  name from the current folder, so on Windows a `gh.exe` inside a checkout could have run with your login. They now
  start it by its full path from your home folder, as the rest of the tool already did; a test covers every program
  the tool starts.
- **Branch names stay plain.** A repository track ignores pull requests whose branch name breaks the `claude/…` rule,
  so line-break or right-to-left characters in a name never reach the events Claude reads.
- **Merged-branch cleanup is stricter** (only with `CLOUD_PILOT_DELETE_MERGED=1`): a branch is deleted only after a
  merge into the repository's default branch.
- **Private files.** On macOS and Linux the data folder is now `0700` and its files `0600`, existing installs included.
- **Bounded cache.** Very large GitHub answers (a flooded comment thread) are no longer kept in the cache file.
- **Windows terminal helper:** never starts a batch file (whose `&`, `|` or `%` in a brief cmd.exe would run),
  takes Windows PowerShell from its system folder, and reads the brief as UTF-8, so Vietnamese and other non-English
  briefs arrive intact. The Python fallback installs `pywinpty` from wheels only, in isolated mode.

## 1.3.0

- **No Python needed on Windows.** `cloud-pilot start` now gives `claude --cloud` its terminal through Windows' own
  pseudo-console (ConPTY) with the built-in Windows PowerShell, so there is nothing to install and no first-run setup.
  Python with `pywinpty` is kept only as a fallback for Windows older than 10 1809 (or where PowerShell may not compile
  the helper), and when `CLOUD_PILOT_PYTHON` is set. macOS and Linux keep using Python's standard `pty` module.
- **No toast for sessions you never asked to follow.** When GitHub cannot be read, branches the watch found on its own
  no longer raise an error notification; kit-cloud shows the problem in its band instead.

## 1.2.2

- **Works with Code Mode.** When Claude Code's Code Mode is on and the account has not yet answered its one-time
  "turn on Code Mode?" question, `start` used to wait on that question until it timed out. It now recognizes the
  question right away and says how to answer it once; Code Mode itself is never turned off.

## 1.2.1

- **The skill names the CLI path itself.** The plugin no longer adds a system-prompt section: on Team and Enterprise
  accounts Claude Code's built-in security plugin keeps prompt content out of reach of installed plugins, so the
  section was skipped (with a "prompt.compose hook was skipped" notice) and Claude did not learn the path.

## 1.2.0

- **`start --model` and `--effort`** pick the cloud session's lead model and effort level (`claude --model <m>
  --effort <e> --cloud` sends both with the new session). Defaults: `CLOUD_PILOT_MODEL`, `CLOUD_PILOT_EFFORT`; unset,
  the account's default model as before.
- **`CLOUD_PILOT_DENY_MODELS`** (for example `opus,fable`) refuses a start whose model contains a listed word, and a
  start without a model while the list is set, so cloud sessions stay below the model of the session that starts them.
- **`questions --repo --pr`** lists a PR's open channel questions with the `question_sha256` that `answer` needs, for
  when the hub event that carried it is lost (the waiter was killed). `answer` points to it when the hash does not match.
- **A PR merged outside GitHub counts as merged.** A PR closed unmerged whose head commit is in its base branch (merged
  locally and pushed, the branch deleted first) is reported as `merged` with `landed: true`, not `closed`; the hub
  waits up to 15 min after the close for that push.
  The skill now says to push the merged default branch before deleting the PR branch when merging on your machine.

## 1.1.1

- This repository now holds releases only: one commit per release, with its notes here and on the Releases page.
  Pull requests are closed with a pointer to issues (see CONTRIBUTING.md); CI runs on every release.

## 1.1.0

- **A started session follows the branch it really pushes.** A cloud session told `claude/<slug>` usually pushes
  `claude/<slug>-<random>` (`claude/fix-login-a1-968lrs`). A branch track whose own branch never appeared now adopts
  that branch (the newest whose tip is not older than the track, that no other track owns and that no longer
  registered slug claims) within 4 h of its start. The track keeps its id, owner and settings, so it no longer reports
  a false `stalled`, and `CLOUD_PILOT_DELETE_MERGED` deletes the real branch after the merge. A track `watch` made for
  that branch meanwhile ends and hands its memo over (no duplicate events).
- **`answer` reads PRs of more than 300 files.** GitHub's compare lists at most 300 files, on its first page only;
  later pages had no `files` and `answer` refused with "unexpected files response". Compare is now read once; past
  300 files the PR's own file list (up to 3000) is read when the PR's base is the default branch and it lists every
  changed file. Past 3000 files, or on another base, the list counts as truncated and `answer` refuses as before.
- `state.json` now lists the sessions with a live waiter (`waiting`, updated at once by `wait`) and the unread events of
  each owner (`queued`): a band can warn a session whose waiter died (kit-cloud 2.1 does). Queued events stay until a
  new waiter takes them.
- Fixed a test that failed once its fixed date was more than a day old.

## 1.0.0

First release. The hub comes from KIT Hub (kit-cloud 1.x in kit-claude-mods), joined by a cross-platform
`start`, the signed question channel, a Claude Code skill and the `/pilot` command. Settings are `CLOUD_PILOT_*`
(the `KIT_HUB_*` names still work); data lives in `~/.claude/cloud-pilot`.