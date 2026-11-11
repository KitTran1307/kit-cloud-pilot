# Changelog

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
