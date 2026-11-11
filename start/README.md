# start

Starts a Claude Code **cloud session** from a script, a tool call or any shell that has no terminal, waits for its
URL, and registers it with the cloud-pilot [hub](../hub/README.md) so the session is watched from then on.

`claude --cloud "<task>"` refuses to run without an interactive terminal (`--cloud requires an interactive terminal`),
so an agent or a script cannot call it directly. `start` runs it inside a pseudo-terminal, reads the line that holds the
session link, closes the local client (the cloud session keeps running) and prints one JSON line.

```
node start/index.mjs --cwd /path/to/repo --brief-file brief.md
```

```
{"ok":true,"session_id":"session_01AbC...","url":"https://claude.ai/code/session_01AbC...","account_dir":"/home/me/.claude","account":"default","repo":"acme/widgets","branch":"claude/pricing-table","hub":{"id":"3f9a1c0b2d"}}
```

## Requirements

| | macOS and Linux | Windows |
|---|---|---|
| Node.js | 18 or newer | 18 or newer |
| Claude Code | `claude` on `PATH`, signed in with a claude.ai account that may start cloud sessions | `claude.exe` on `PATH` (the native install), same sign-in |
| Python | 3.7 or newer (`python3` or `python`); standard library only | 3.7 or newer (`python3`, `python` or `py -3`) |
| Terminal backend | the `pty` module of the standard library | the package `pywinpty` (ConPTY), installed for you, see below |
| git | on `PATH` (finds the GitHub origin for tracking) | same |

Tracking also needs what the hub needs: the GitHub CLI (`gh`) signed in. Run `node hub/hub.mjs doctor` to check.

**Windows, first use.** `start` creates a virtual environment under the hub's data folder (`<data dir>/venv`), installs
`pywinpty` into it with pip, and reuses it afterwards. This needs Python's `venv` module, pip and internet access once.
If that fails, the error says what to run by hand:

```
python -m venv "<data dir>\venv"
"<data dir>\venv\Scripts\python.exe" -m pip install pywinpty==3.1.2
```

The data folder is `CLOUD_PILOT_DIR`, default `~/.claude/cloud-pilot`. A Python that already has `pywinpty` is used as it
is, with no venv.

The installed `pywinpty` is pinned to `pywinpty==3.1.2` (`PYWINPTY_SPEC` in `runner.mjs`), the release the terminal helper
was tested with. To move to a newer one: install it in a scratch venv, run
`CLOUD_PILOT_PYTHON=<that venv>\Scripts\python.exe node --test start/tests/pty.test.mjs` until it passes, then change
`PYWINPTY_SPEC` and the version above. Only one process sets up the venv at a time (`venv.lock` in the data folder, taken
over once nobody has touched it for 15 minutes).

Programs are started by their full path, found on `PATH` without looking in the current folder, and from the home folder,
so a `python.exe` or `py.exe` in a repository root is never run. `claude` is looked up the same way: empty and relative
`PATH` entries are skipped.

**Windows and `claude.cmd`.** The npm install puts a `claude.cmd` shim on `PATH`. A `.cmd` file runs through `cmd.exe`,
which would parse the brief as shell text (quotes, `&`, `%VAR%`). `start` therefore uses a real `claude.exe` from any
`PATH` folder first (a `claude.cmd` in an earlier folder does not hide it), then the native `claude.exe` that ships inside
the npm package next to a `claude.cmd`, and otherwise refuses with a message. Point
`CLOUD_PILOT_CLAUDE_BIN` at a `claude.exe` to fix it.

## Usage

```
node start/index.mjs [--cwd <repo>] (--brief-file <file> | --brief "<text>") [options]
```

| Option | Meaning |
|---|---|
| `--cwd <repo>` | Repository the session starts from. Default: the current directory. |
| `--brief-file <file>` | The task, read from a UTF-8 file (a leading byte-order mark is dropped). Preferred: nothing to quote. |
| `--brief "<text>"` | The task on the command line. Exactly one of `--brief` and `--brief-file` is required. |
| `--branch claude/<slug>` | The branch the session works on. Default: taken from the brief, see below. |
| `--title "<text>"` | Title shown by the hub. Default: the first line of the brief that has a letter or digit in it, at most 200 characters. |
| `--timeout <sec>` | How long to wait for the session link. Default 90, at most 3600. Setting up Python on first use is not counted. |
| `--no-track` | Do not register the session with the hub. |
| `--help` | Print the usage text (the only output that is not JSON) and exit 0. |

`--flag value` and `--flag=value` both work; a value that starts with `--` is still a value.

Use from Node:

```js
import { main } from './start/index.mjs';
const exitCode = await main(['--cwd', repo, '--brief-file', file]); // prints one JSON line, resolves to 0 or 1
```

### The brief

- At most **24,000 characters**: the brief is one process argument and a Windows command line stops at 32,767.
  Point at files in the repository instead of pasting them.
- **Do not put secrets in a brief.** `claude --cloud <brief>` takes the brief as a command-line argument, so it is
  visible in the process list of the machine while the local client runs (a few seconds). `start` itself passes the
  brief to its terminal helper over a pipe, never through a shell and never as part of a command string.
- A brief that starts with `-` gets one leading space so `claude` reads it as a value, not as an option.
- The cloud VM does not read your local `~/.claude` folder (no user settings, skills or CLAUDE.md): the brief must carry
  what the task needs. A repository's committed `.claude/` files do reach it.

### The branch

`--branch` wins. Without it, the branch is the first `claude/<slug>` on a line of the brief that also contains the word
"branch": `Work on branch claude/pricing-table and open a PR`. A `claude/...` anywhere else is ignored, and so is part of
a longer path (`.claude/cloud/policy.md`, `origin/claude/x`). No such line means no branch: the session is still tracked,
by its URL. `--branch` must look like `claude/<slug>` (the hub's rule); anything else is a usage error and nothing starts.

## What it prints

Exactly one JSON line, exit code 0 on success and 1 on any failure.

Success:

| Field | Value |
|---|---|
| `ok` | `true` |
| `session_id` | `session_...` |
| `url` | `https://claude.ai/code/session_...` |
| `account_dir` | The `CLAUDE_CONFIG_DIR` of the caller, or `""` |
| `account` | The account name: `default` for `~/.claude`, `work` for `~/.claude-work`, from `CLAUDE_CONFIG_DIR` (same rule as the hub) |
| `repo` | `owner/name` of the GitHub origin, or `""` |
| `branch` | The branch used for tracking, or `""` |
| `hub` | `{"id":"<track id>"}` when registered; `"skipped: --no-track"` or `"skipped: no GitHub origin"`; `"failed: <why>"` if registering failed. If the hub could not be launched the object also has `"daemon":"not started: <why>"`. A hub problem never turns a started session into a failure. |

Failure:

```
{"ok":false,"error":"no cloud session URL within 90s","tail":"...last 2,000 characters of cleaned output..."}
```

`tail` is only present when `claude` printed something. `prompt` (`trust`, `login`, `picker` or `confirm`) is present when
`claude` stopped at a question. Errors you can get:

| `error` starts with | Meaning |
|---|---|
| `usage: ...` | Bad or missing options. Nothing was started. |
| `account <name> is local-only (CLOUD_PILOT_LOCAL_ONLY)` | The account is on the local-only list. Nothing was started. |
| `the brief is empty` / `is N characters; keep it under 24000` / `cannot read the brief file` | Brief problems. |
| `cwd not found` | `--cwd` is not a folder. |
| `claude not found` | No `claude` on `PATH` and no valid `CLOUD_PILOT_CLAUDE_BIN`. |
| `Python 3.7 or newer is required` | No usable Python. The message says what to install. |
| `could not set up pywinpty` | Windows venv or pip step failed. The message lists the commands to run by hand. |
| `claude --cloud stopped at a <kind> prompt` | `claude` asked a trust, login, picker or yes/no question. See below. |
| `no cloud session URL within <n>s` | Nothing that looks like a session link appeared in time. `tail` shows what did. |
| `claude ended before it created a cloud session` | `claude` exited first (with its exit code when known). `tail` shows why. |

### Prompts are never answered

If `claude --cloud` asks the folder trust question, a login choice, an environment or repository picker or a `(y/n)`
question, `start` closes it and fails, naming which one (`prompt` field). It never answers for you. Answer it once by
hand (`claude` in that folder for trust, `claude auth login` for login) and start again.

Prompts are recognized from `claude`'s own lines only. Lines that merely echo the brief are ignored, so a brief about
fixing a login page, or one that quotes a prompt, is not mistaken for one.

## Settings

Environment variables (the older `KIT_HUB_<NAME>` spelling is read when `CLOUD_PILOT_<NAME>` is unset):

| Variable | Meaning |
|---|---|
| `CLOUD_PILOT_CLAUDE_BIN` | The `claude` executable to run: a full path, or a name looked up on `PATH`. A `.js`, `.mjs` or `.cjs` file is run with Node (that is how the tests use a stand-in). |
| `CLOUD_PILOT_LOCAL_ONLY` | Comma-separated account names that must never start cloud sessions, for example `work,client`. Matching ignores case. |
| `CLOUD_PILOT_PERMISSION_MODE` | Permission mode for new sessions when `--permission-mode` is not given: `auto`, `acceptEdits` or `plan`. It is passed as `claude --permission-mode <m> --cloud`. `bypassPermissions` and `dontAsk` are refused: cloud sessions do not offer them and would drop them silently. |
| `CLOUD_PILOT_PYTHON` | The Python 3 executable to use instead of searching for `python3`, `python` or `py -3`. |
| `CLOUD_PILOT_DIR` | The data folder (default `~/.claude/cloud-pilot`): hub state, `sessions.jsonl`, and on Windows `venv/`. |

## Log

Every start appends one line to `<data dir>/sessions.jsonl`:

```
{"time":"2025-01-31T09:30:00.000Z","account":"default","repo":"acme/widgets","branch":"claude/pricing-table","title":"Add a pricing table","session_id":"session_...","url":"https://claude.ai/code/session_..."}
```

The brief text is never logged (the title is its first line, so keep the first line free of secrets too). Failed starts
log nothing.

## How it works

1. Reads the options, refuses local-only accounts, loads and checks the brief, finds `claude`.
2. Finds Python and, on Windows, a Python that has `pywinpty` (creating the venv once).
3. Runs `python -I pty_run.py`, sends it `{argv, cwd}` as one JSON line on stdin. `pty_run.py` starts
   `claude --cloud <brief>` in a pseudo-terminal (ConPTY through `pywinpty` on Windows, the `pty` module elsewhere) and
   relays everything it prints.
4. Cleans the terminal output (escape sequences, cursor moves, carriage returns) and looks for the session link, ignoring
   any session link that the brief itself contains and waiting a moment when a link ends the output (it may be cut).
5. Closes the helper's stdin: the helper terminates `claude` and exits. The cloud session keeps running.
6. Registers the session with the hub in-process (`addTrack`, then `ensureHub`), appends to `sessions.jsonl`, prints JSON.

Files: `index.mjs` (entry and `main`), `lib.mjs` (pure logic: parsing, cleanup, URL and prompt detection, branch and title
rules, locating `claude`), `runner.mjs` (Python lookup, Windows venv, running the helper), `pty_run.py` (the terminal
helper, standard library plus `pywinpty` on Windows).

## Limits

- It reads the text `claude --cloud` prints. If a future `claude` prints the link differently, starts end in a timeout
  (with the output in `tail`) rather than a wrong answer.
- No GitHub origin, or a GitHub repository the Claude GitHub App is not installed on: `claude` can still start the
  session by uploading the local repository. Then `hub` is `skipped: no GitHub origin` and nothing is tracked. On native
  Windows, uncommitted edits to tracked files upload as they are, credential-named files included (see the Claude Code
  documentation, "Send local repositories without GitHub"). `start` does not check for that: commit or stash first.
- It does not choose a model or effort: the session starts with the account's defaults.
- One start at a time per call; run several calls for several sessions. Windows first-use setup is serialized by a lock.
- Follow-up messages to a running session need no wrapper: `claude -p "message" --cloud <session_id>`.

## Tests

```
node --test start/tests/*.test.mjs
```

No network, no real `claude`: a fake `claude` (`tests/fixtures/fake-claude.mjs`) stands in through
`CLOUD_PILOT_CLAUDE_BIN`, and the hub runs against a temporary `CLOUD_PILOT_DIR` with its daemon launch stubbed out.
The terminal tests (`tests/pty.test.mjs`) run the real `pty_run.py`. On macOS and Linux they need only Python 3. On
Windows they run when the Python found has `pywinpty` (for example
`CLOUD_PILOT_PYTHON=<venv>\Scripts\python.exe node --test start/tests/pty.test.mjs`) and are skipped, with the reason,
otherwise. Everything else runs on every system.
