import os
import shutil
import signal
import subprocess
import threading
from pathlib import Path


class CommandCancelled(InterruptedError):
    """Raised when a user explicitly stops the active command."""


class CommandTimedOut(TimeoutError):
    """Raised when a command exceeds its configured runtime."""


class CommandRunner:
    """Runs allowlisted argv commands and streams combined output without a shell."""

    BLOCKED = {"cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
               "bash", "sh", "zsh", "wscript", "cscript"}

    def __init__(self, allowed_executables, timeout_seconds=1800):
        self.allowed = {str(x).lower() for x in allowed_executables}
        self.timeout_seconds = max(1, int(timeout_seconds))
        self.process = None
        self._cancel = threading.Event()
        self._lock = threading.RLock()
        self._stop_reason = None

    def validate(self, argv):
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
            raise ValueError("Command must be a non-empty argv list.")
        if any("\x00" in value for value in argv):
            raise ValueError("Command arguments cannot contain NUL bytes.")
        executable = Path(argv[0]).name.lower()
        if executable not in self.allowed:
            raise ValueError(f"Executable '{executable}' is not in allowed_executables.")
        if executable in self.BLOCKED:
            raise ValueError("Shell interpreters are blocked. Configure a direct executable instead.")
        resolved = shutil.which(argv[0]) if not Path(argv[0]).is_absolute() else argv[0]
        if not resolved or not Path(resolved).is_file():
            raise ValueError(f"Executable not found: {argv[0]}")
        return [resolved, *argv[1:]]

    def run(self, argv, cwd, on_line):
        safe_argv = self.validate(argv)
        workdir = Path(cwd).resolve()
        if not workdir.is_dir():
            raise ValueError(f"Working directory does not exist: {workdir}")
        self._cancel.clear()
        with self._lock:
            self._stop_reason = None

        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        process = subprocess.Popen(
            safe_argv, cwd=str(workdir), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace", bufsize=1, shell=False,
            creationflags=creationflags,
            start_new_session=(os.name != "nt"),
        )
        with self._lock:
            self.process = process

        timer = threading.Timer(self.timeout_seconds, lambda: self.stop(reason="timeout"))
        timer.daemon = True
        timer.start()
        try:
            for line in iter(process.stdout.readline, ""):
                if self._cancel.is_set():
                    break
                on_line(line.rstrip("\r\n"))
            code = process.wait()
            with self._lock:
                reason = self._stop_reason
            if reason == "timeout":
                raise CommandTimedOut(f"Command exceeded {self.timeout_seconds} seconds.")
            if reason == "cancelled":
                raise CommandCancelled("Command stopped by user.")
            return code
        finally:
            timer.cancel()
            if process.stdout:
                process.stdout.close()
            with self._lock:
                if self.process is process:
                    self.process = None

    def stop(self, reason="cancelled"):
        with self._lock:
            if self.process is None:
                return
            self._stop_reason = reason
            self._cancel.set()
            process = self.process

        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                # taskkill is invoked directly (no shell) to terminate the agent's child tree.
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, check=False, timeout=10,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            else:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.kill()
