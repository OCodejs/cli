import json
import logging
import queue
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from pathlib import Path

from core.github_client import GitHubClient
from core.models import Task
from core.orchestrator import Orchestrator
from core.runner import CommandCancelled, CommandTimedOut, CommandRunner


BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
logging.basicConfig(filename=BASE / "control-center.log", level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


def load_config():
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {
        "repository": "zskbot/ocodejs-cli", "project_dir": str(BASE.parent),
        "refresh_seconds": 30, "command_timeout_seconds": 1800,
        "allowed_executables": ["python", "node", "npm", "npx", "git", "pytest", "codex", "claude", "gemini"],
        "agents": {},
    }


class ControlCenter(tk.Tk):
    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.title("OCode.js · AI Live Control Center")
        self.geometry("1440x900")
        self.minsize(1080, 700)
        self.configure(bg="#0b1020")
        self.events = queue.Queue()
        self.tasks = []
        self.current_task = None
        self.runner = None
        self._style()
        self._layout()
        self._refresh_prs()
        self.after(100, self._drain_events)
        self.after(1000, self._tick)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _style(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(".", background="#111a2e", foreground="#e5eaf5", fieldbackground="#17233b")
        style.configure("TFrame", background="#111a2e")
        style.configure("TLabel", background="#111a2e", foreground="#e5eaf5", font=("Segoe UI", 10))
        style.configure("Title.TLabel", font=("Segoe UI Semibold", 18), foreground="#ffffff")
        style.configure("Muted.TLabel", foreground="#91a0bd")
        style.configure("TButton", background="#263653", foreground="#ffffff", padding=8)
        style.map("TButton", background=[("active", "#38527d")])
        style.configure("Treeview", background="#101a2c", fieldbackground="#101a2c",
                        foreground="#e5eaf5", rowheight=30, borderwidth=0)
        style.configure("Treeview.Heading", background="#263653", foreground="#ffffff")
        style.configure("TEntry", fieldbackground="#101a2c", foreground="#ffffff")

    def _layout(self):
        header = ttk.Frame(self, padding=16)
        header.pack(fill="x")
        ttk.Label(header, text="AI LIVE CONTROL CENTER", style="Title.TLabel").pack(side="left")
        self.status = tk.StringVar(value="● READY")
        ttk.Label(header, textvariable=self.status).pack(side="right")
        ttk.Label(self, text=f"ORCHESTRATOR  /  {self.cfg['repository']}  /  LOCAL PC",
                  style="Muted.TLabel").pack(anchor="w", padx=18)

        controls = ttk.Frame(self, padding=(16, 12))
        controls.pack(fill="x")
        ttk.Label(controls, text="Task brief").pack(side="left")
        self.brief = tk.StringVar()
        ttk.Entry(controls, textvariable=self.brief).pack(side="left", fill="x", expand=True, padx=10)
        ttk.Button(controls, text="Build workflow", command=self._build_workflow).pack(side="left")
        ttk.Button(controls, text="Choose project", command=self._choose_project).pack(side="left", padx=6)
        ttk.Button(controls, text="Refresh PRs", command=self._refresh_prs).pack(side="left")

        body = ttk.Panedwindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        left, right = ttk.Frame(body, padding=10), ttk.Frame(body, padding=10)
        body.add(left, weight=3)
        body.add(right, weight=5)
        ttk.Label(left, text="TASK QUEUE · APPROVAL + DEPENDENCY GATES").pack(anchor="w", pady=(0, 8))
        self.task_tree = ttk.Treeview(left, columns=("role", "title", "status"), show="headings")
        for col, width in (("role", 90), ("title", 210), ("status", 130)):
            self.task_tree.heading(col, text=col.upper())
            self.task_tree.column(col, width=width, anchor="w")
        self.task_tree.pack(fill="both", expand=True)
        self.task_tree.bind("<<TreeviewSelect>>", self._select_task)
        task_buttons = ttk.Frame(left, padding=(0, 10))
        task_buttons.pack(fill="x")
        ttk.Button(task_buttons, text="Approve & run", command=self._approve_selected).pack(fill="x", pady=3)
        ttk.Button(task_buttons, text="Stop agent", command=self._stop).pack(fill="x", pady=3)

        ttk.Label(right, text="LIVE TERMINAL · STREAMED OUTPUT").pack(anchor="w", pady=(0, 8))
        self.terminal = tk.Text(right, bg="#070c16", fg="#c9d7ef", insertbackground="white",
                                font=("Cascadia Mono", 10), wrap="word", relief="flat")
        self.terminal.pack(fill="both", expand=True)
        self.terminal.insert("end", "Control Center ready. Configure agent CLI commands in config.json.\n")
        self.terminal.configure(state="disabled")

        bottom = ttk.Frame(self, padding=(16, 0, 16, 16))
        bottom.pack(fill="x")
        ttk.Label(bottom, text="GITHUB PULL REQUESTS").pack(anchor="w", pady=(0, 6))
        self.pr_tree = ttk.Treeview(bottom, columns=("number", "title", "state", "draft", "url"),
                                    show="headings", height=6)
        for col, width in (("number", 70), ("title", 480), ("state", 90), ("draft", 70), ("url", 420)):
            self.pr_tree.heading(col, text=col.upper())
            self.pr_tree.column(col, width=width, anchor="w")
        self.pr_tree.pack(fill="x")
        ttk.Label(bottom, text="GITHUB ACTIONS · RECENT CI RUNS").pack(anchor="w", pady=(10, 6))
        self.ci_tree = ttk.Treeview(bottom, columns=("workflow", "event", "status", "branch", "url"),
                                    show="headings", height=4)
        for col, width in (("workflow", 280), ("event", 100), ("status", 120), ("branch", 220), ("url", 400)):
            self.ci_tree.heading(col, text=col.upper())
            self.ci_tree.column(col, width=width, anchor="w")
        self.ci_tree.pack(fill="x")

    def _log(self, message):
        logging.info(message)
        self.terminal.configure(state="normal")
        self.terminal.insert("end", message + "\n")
        self.terminal.see("end")
        self.terminal.configure(state="disabled")

    def _build_workflow(self):
        brief = self.brief.get().strip()
        if not brief:
            messagebox.showwarning("Task brief required", "Enter the outcome you want the agents to deliver.")
            return
        tasks = Orchestrator(self.cfg.get("agents", {}), self.cfg["repository"]).build_workflow(brief)
        if not tasks:
            messagebox.showerror("Agents not configured", "Copy config.example.json to config.json and configure agent CLI commands.")
            return
        self.tasks.extend(tasks)
        self._render_tasks()
        self._log(f"[ORCHESTRATOR] Created {len(tasks)} dependent tasks. Each stage needs approval and predecessor success.")

    def _render_tasks(self):
        for item in self.task_tree.get_children():
            self.task_tree.delete(item)
        for task in self.tasks:
            self.task_tree.insert("", "end", iid=task.id,
                                  values=(task.role, task.title, task.status.upper()))

    def _select_task(self, _event=None):
        selection = self.task_tree.selection()
        if selection:
            task = next((t for t in self.tasks if t.id == selection[0]), None)
            if task:
                self._log(f"[SELECTED] {task.title} · {task.role} · {task.status}")

    def _approve_selected(self):
        if self.current_task and self.current_task.status == "running":
            messagebox.showinfo("Agent busy", "Wait for or stop the current agent first.")
            return
        selection = self.task_tree.selection()
        if not selection:
            messagebox.showinfo("Select task", "Select a task in the queue first.")
            return
        task = next((t for t in self.tasks if t.id == selection[0]), None)
        if not task or task.status != "pending":
            return
        dependency_map = {item.id: item for item in self.tasks}
        blocked = [dependency_map[dep] for dep in task.depends_on if dep in dependency_map
                   and dependency_map[dep].status != "completed"]
        if blocked:
            messagebox.showwarning("Stage is blocked",
                "Complete the previous stage successfully before approving this task:\n" +
                "\n".join(f"{item.role}: {item.status}" for item in blocked))
            return
        if not messagebox.askyesno("Approve agent execution",
                f"Role: {task.role}\nTask: {task.title}\n\nExecutable arguments:\n" +
                "\n".join(task.command) + "\n\nRun this agent now?"):
            return
        try:
            task.transition("awaiting_approval")
            task.transition("running")
        except ValueError as exc:
            messagebox.showerror("State error", str(exc))
            return
        self.current_task = task
        self.runner = CommandRunner(self.cfg.get("allowed_executables", []),
                                    self.cfg.get("command_timeout_seconds", 1800))
        self.status.set(f"● RUNNING · {task.role.upper()}")
        self._render_tasks()
        self._log(f"[START] {task.role}: {task.title}")
        threading.Thread(target=self._run_task, args=(task, self.runner), daemon=True).start()

    def _run_task(self, task, runner):
        try:
            code = runner.run(task.command, self.cfg["project_dir"],
                              lambda line: self.events.put(("line", line)))
            self.events.put(("finished", task.id, code, None))
        except CommandCancelled as exc:
            self.events.put(("finished", task.id, -2, str(exc)))
        except CommandTimedOut as exc:
            self.events.put(("finished", task.id, -3, str(exc)))
        except Exception as exc:
            self.events.put(("finished", task.id, -1, str(exc)))

    def _drain_events(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "line":
                    self._log(event[1])
                elif event[0] == "finished":
                    _, task_id, code, error = event
                    task = next((t for t in self.tasks if t.id == task_id), None)
                    if task and task.status == "running":
                        task.return_code = code
                        next_status = "cancelled" if code == -2 else (
                            "completed" if code == 0 and not error else "failed")
                        task.transition(next_status)
                    self._log(f"[EXIT] task={task_id} code={code} {error or ''}")
                    self.current_task = None
                    self.runner = None
                    self.status.set("● READY")
                    self._render_tasks()
                elif event[0] == "prs":
                    for item in self.pr_tree.get_children():
                        self.pr_tree.delete(item)
                    for pr in event[1]:
                        self.pr_tree.insert("", "end", values=(
                            f"#{pr['number']}", pr.get("title", ""), pr.get("state", ""),
                            str(pr.get("draft", False)), pr.get("html_url", "")))
                    self._log(f"[GITHUB] Loaded {len(event[1])} open pull requests.")
                elif event[0] == "prs_error":
                    self._log(f"[GITHUB] PR refresh failed: {event[1]}")
                elif event[0] == "ci":
                    for item in self.ci_tree.get_children():
                        self.ci_tree.delete(item)
                    for run in event[1]:
                        self.ci_tree.insert("", "end", values=(
                            run.get("name", ""), run.get("event", ""),
                            f"{run.get('status', '')}/{run.get('conclusion') or 'pending'}",
                            run.get("head_branch", ""), run.get("html_url", "")))
                    self._log(f"[GITHUB] Loaded {len(event[1])} recent workflow runs.")
                elif event[0] == "ci_error":
                    self._log(f"[GITHUB] CI refresh failed: {event[1]}")
        except queue.Empty:
            pass
        self.after(100, self._drain_events)

    def _stop(self):
        if self.runner:
            self.runner.stop(reason="cancelled")
            self._log("[STOP] Stop requested; child processes are terminated as a process tree.")

    def _choose_project(self):
        folder = filedialog.askdirectory(initialdir=self.cfg.get("project_dir", str(BASE.parent)))
        if folder:
            self.cfg["project_dir"] = folder
            self._save_config()
            self._log(f"[CONFIG] Project directory: {folder}")

    def _save_config(self):
        CONFIG_PATH.write_text(json.dumps(self.cfg, indent=2), encoding="utf-8")

    def _refresh_prs(self):
        def worker():
            try:
                client = GitHubClient(self.cfg["repository"])
                prs = client.pull_requests("open")
                runs = client.workflow_runs(per_page=10)
                self.events.put(("prs", prs))
                self.events.put(("ci", runs))
            except Exception as exc:
                self.events.put(("prs_error", str(exc)))
                self.events.put(("ci_error", str(exc)))
        threading.Thread(target=worker, daemon=True).start()

    def _tick(self):
        self._refresh_prs()
        self.after(max(10, int(self.cfg.get("refresh_seconds", 30))) * 1000, self._tick)

    def _on_close(self):
        if self.runner:
            self.runner.stop(reason="cancelled")
        self.destroy()


if __name__ == "__main__":
    ControlCenter().mainloop()
