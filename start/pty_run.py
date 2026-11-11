"""Run one command inside a pseudo-terminal and relay what it prints.

`claude --cloud` refuses to run without a terminal, and a tool call or a script has none. This helper gives it one.
Run it as `python -I pty_run.py` (isolated mode). The Node side is runner.mjs.

Protocol
  stdin   first line: JSON {"argv": [...], "cwd": "...", "rows": 50, "cols": 200}
          the pipe is then left open; closing it tells this helper to stop the command and exit.
  stdout  everything the command prints, as raw UTF-8 bytes, as it arrives.
  stderr  one-line diagnostics, each starting with "pty_run:".
  exit    0 normal; 2 bad request; 3 pseudo-terminal backend missing; 4 the command could not be started.

  python -I pty_run.py --check   exit 0 when the backend is available on this machine, else 3.

Windows uses the third-party package pywinpty (ConPTY). macOS and Linux use the standard library `pty` module only.
"""
import json
import os
import shutil
import sys
import threading
import time

WINDOWS = os.name == 'nt'


def say(message):
    sys.stderr.write('pty_run: %s\n' % message)
    sys.stderr.flush()


class WindowsBackend(object):
    """ConPTY through pywinpty."""

    def __init__(self, argv, cwd, rows, cols):
        from winpty import PtyProcess  # ImportError is reported by main()
        self.proc = PtyProcess.spawn(argv, cwd=cwd, dimensions=(rows, cols))

    def read(self):
        """Bytes, None when nothing arrived yet, b'' at the end of the output."""
        try:
            data = self.proc.read(4096)
        except EOFError:
            return b''
        if data:
            return data.encode('utf-8', 'replace')
        return None if self.proc.isalive() else b''

    def exit_code(self):
        try:
            return None if self.proc.isalive() else self.proc.exitstatus
        except Exception:
            return None

    def terminate(self):
        try:
            self.proc.terminate(force=True)
        except Exception:
            pass
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                if not self.proc.isalive():
                    break
            except Exception:
                break
            time.sleep(0.05)
        try:
            self.proc.close(force=True)
        except Exception:
            pass


class PosixBackend(object):
    """The standard library pty module (macOS, Linux)."""

    def __init__(self, argv, cwd, rows, cols):
        import pty
        import struct
        import fcntl
        import termios
        env = dict(os.environ)
        env.setdefault('TERM', 'xterm-256color')
        pid, fd = pty.fork()
        if pid == 0:  # the child: its stdin, stdout and stderr are the terminal
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except Exception as err:
                sys.stderr.write('cannot start %s: %s\n' % (argv[0], err))
                sys.stderr.flush()
            os._exit(127)
        self.pid, self.fd, self.status = pid, fd, None
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        except Exception:
            pass

    def read(self):
        try:
            return os.read(self.fd, 4096)  # b'' at the end on macOS
        except OSError:
            return b''  # EIO on Linux once the child side is closed

    def _reap(self):
        if self.status is None:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                self.status = -1
                return
            if pid:
                self.status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)

    def exit_code(self):
        self._reap()
        return None if self.status in (None, -1) else self.status

    def terminate(self):
        import signal
        self._reap()
        for sig, wait in ((signal.SIGTERM, 1.5), (signal.SIGKILL, 1.5)):
            if self.status is not None:
                break
            try:
                os.killpg(self.pid, sig)  # the child leads its own session, so its pid is its group id
            except Exception:
                try:
                    os.kill(self.pid, sig)
                except Exception:
                    pass
            deadline = time.time() + wait
            while self.status is None and time.time() < deadline:
                time.sleep(0.05)
                self._reap()
        try:
            os.close(self.fd)
        except OSError:
            pass


def backend_class():
    if WINDOWS:
        import winpty  # noqa: F401  (only checks that the package is installed)
        return WindowsBackend
    import pty  # noqa: F401
    return PosixBackend


def read_request():
    line = sys.stdin.buffer.readline()
    try:
        req = json.loads(line.decode('utf-8'))
        argv, cwd = req['argv'], req['cwd']
        if not (isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv) and isinstance(cwd, str)):
            raise ValueError('argv must be a non-empty list of strings and cwd a string')
        return argv, cwd, int(req.get('rows', 50)), int(req.get('cols', 200))
    except Exception as err:
        say('bad request: %s' % err)
        sys.exit(2)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--check':
        try:
            backend_class()
        except ImportError:
            return 3
        return 0

    argv, cwd, rows, cols = read_request()
    try:
        backend = backend_class()
    except ImportError as err:
        say('pseudo-terminal backend missing (%s); on Windows run: python -m pip install pywinpty' % err)
        return 3
    if not os.path.isdir(cwd):
        say('directory not found: %s' % cwd)
        return 4
    if shutil.which(argv[0]) is None:
        say('cannot start %s: not found' % argv[0])
        return 4
    os.environ.setdefault('TERM', 'xterm-256color')
    try:
        term = backend(argv, cwd, rows, cols)
    except Exception as err:
        say('cannot start %s: %s' % (argv[0], err))
        return 4

    stop = threading.Event()  # the Node side closed our stdin
    done = threading.Event()  # the command ended on its own

    def pump():
        out = sys.stdout.buffer
        try:
            while not stop.is_set():
                data = term.read()
                if data is None:
                    time.sleep(0.02)
                    continue
                if not data:
                    break
                out.write(data)
                out.flush()
        except Exception:
            pass  # our stdout went away: nobody is listening any more
        finally:
            done.set()

    def watch_stdin():
        try:
            sys.stdin.buffer.read()  # returns at EOF, when Node closes the pipe
        except Exception:
            pass
        stop.set()

    for fn in (pump, watch_stdin):
        threading.Thread(target=fn, daemon=True).start()
    while not (stop.is_set() or done.is_set()):
        time.sleep(0.05)

    ended_by_itself = done.is_set() and not stop.is_set()
    if ended_by_itself:
        time.sleep(0.2)  # let the system record how it ended
    code = term.exit_code()
    term.terminate()
    if ended_by_itself and code is not None:
        say('child exited with code %s' % code)
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(0)  # a reader thread may still be blocked in the terminal: do not wait for it


if __name__ == '__main__':
    sys.exit(main())
