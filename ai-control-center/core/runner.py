import os
import shutil
import subprocess
import threading
from pathlib import Path


class CommandRunner:
    """Runs argv commands only (never shell=True) and streams output via callbacks."""

    def __init__(self, allowed_executables, timeout_seconds=1800):
        self.allowed = {str(x).lower() for x in allowed_executables}
        self.timeout_seconds = int(timeout_seconds)
        self.process = None
        self._cancel = threading.Event()

    def validate(self, argv):
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
            raise ValueError("Command must be a non-empty argv list.")
        executable = Path(argv[0]).name.lower()
        if executable not in self.allowed:
            raise ValueError(f"Executable '{executable}' is not in allowed_executables.")
        if executable in {"cmd", "cmd.exe", "powershell", "pwsh", "bash", "sh", "zsh"}:
            raise ValueError("Shell interpreters are blocked. Configure a direct executable instead.")
        resolved = shutil.which(argv[0]) if not Path(argv[0]).is_absolute() else argv[0]
        if not resolved or not Path(resolved).exists():
            raise ValueError(f"Executable not found: {argv[0]}")
        return [resolved, *argv[1:]]

    def run(self, argv, cwd, on_line):
        safe_argv = self.validate(argv)
        self._cancel.clear()
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        self.process = subprocess.Popen(
            safe_argv,
            cwd=str(Path(cwd).resolve()),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
            creationflags=creationflags,
        )
        timer = threading.Timer(self.timeout_seconds, self.stop)
        timer.daemon = True
        timer.start()
        try:
            for line in iter(self.process.stdout.readline, ""):
                if self._cancel.is_set():
                    break
                on_line(line.rstrip("\r\n"))
            code = self.process.wait(timeout=5)
            if self._cancel.is_set():
                raise InterruptedError("Process cancelled or timed out.")
            return code
        finally:
            timer.cancel()
            if self.process and self.process.stdout:
                self.process.stdout.close()
            self.process = None

    def stop(self):
        self._cancel.set()
        process = self.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
