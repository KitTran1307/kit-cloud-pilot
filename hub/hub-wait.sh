#!/usr/bin/env bash
# Light waiter for the cloud-pilot hub: run it with Bash run_in_background; it exits with one JSON line when the hub has events
# for this session ({"status":"events",...}), when this session tracks nothing ({"status":"nothing-tracked"}) or at
# --max-min ({"status":"timeout"}). The loop is plain bash (a few MB); node runs only to begin, take events and end.
#   bash <plugin>/hub/hub-wait.sh [--max-min 240] [--settle-sec 60]
# Needs bash and node on PATH (Git Bash on Windows).
set -u
HUB="$(cd "$(dirname "$0")" && pwd)/hub.mjs"
command -v node >/dev/null 2>&1 || { echo '{"status":"error","message":"node is not on PATH"}'; exit 1; }
MAX_MIN=240
SETTLE=60
while [ $# -gt 0 ]; do
  case "$1" in
    --max-min) MAX_MIN="$2"; shift 2 ;;
    --settle-sec) SETTLE="$2"; shift 2 ;;
    *) echo "{\"status\":\"usage\",\"message\":\"unknown option $1\"}"; exit 1 ;;
  esac
done
WINPID="$(cat /proc/$$/winpid 2>/dev/null || echo $$)"
QUEUE="$(node "$HUB" wait-begin --waiter-pid "$WINPID")" || { echo '{"status":"error","message":"wait-begin failed"}'; exit 1; }
QUEUE="$(printf '%s' "$QUEUE" | tr -d '\r')"
START=$(date +%s)
LAST_TAKE=$START
CHECKED_EARLY=0
trap 'node "$HUB" wait-end --waiter-pid "$WINPID" >/dev/null 2>&1' EXIT
while :; do
  NOW=$(date +%s)
  # wc works the same on GNU, BSD/macOS and Git Bash (stat's flags differ between them).
  SIZE=$( (wc -c < "$QUEUE") 2>/dev/null | tr -d ' ' )
  [ -n "$SIZE" ] || SIZE=0
  # A queue file holds "[]" (2 bytes) when empty: then node runs only once at ~15 s (notices "nothing tracked")
  # and every 5 minutes (restarts a hub that died). Events in the file are taken at once.
  EARLY=0
  if [ $CHECKED_EARLY -eq 0 ] && [ $((NOW - START)) -ge 15 ]; then EARLY=1; CHECKED_EARLY=1; fi
  NAP=3
  if [ "$SIZE" -gt 2 ] || [ $EARLY -eq 1 ] || [ $((NOW - LAST_TAKE)) -ge 300 ]; then
    LAST_TAKE=$NOW
    OUT="$(node "$HUB" wait-take --settle-sec "$SETTLE" --since "$START" 2>/dev/null)"
    case "$OUT" in
      *'"status":"events"'*|*'"status":"nothing-tracked"'*) printf '%s\n' "$OUT"; exit 0 ;;
      *'"status":"settling"'*)
        # Non-urgent events wait out the settle time: sleep it instead of asking every 3 s.
        NAP=$(printf '%s' "$OUT" | sed -n 's/.*"retry_sec":\([0-9][0-9]*\).*/\1/p')
        [ -n "$NAP" ] || NAP=3
        [ "$NAP" -gt 60 ] && NAP=60
        LAST_TAKE=0 ;;  # take again right after the nap
      '') ;;
      *) LAST_TAKE=$((NOW - 270)) ;;  # a hub error (busy lock, ...): retry in ~30 s, never exit on it
    esac
  fi
  if [ $((NOW - START)) -ge $((MAX_MIN * 60)) ]; then
    trap - EXIT
    node "$HUB" wait-end --waiter-pid "$WINPID" --timeout "$MAX_MIN"
    exit 0
  fi
  sleep "$NAP"
done
