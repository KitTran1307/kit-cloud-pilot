# Changelog

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
