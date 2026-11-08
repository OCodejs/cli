import unittest
from core.models import Task
from core.orchestrator import Orchestrator
from core.runner import CommandRunner


class CoreTests(unittest.TestCase):
    def test_task_requires_approval_before_running(self):
        task = Task(title="test", role="tester", prompt="test", command=["python", "--version"])
        with self.assertRaises(ValueError):
            task.transition("running")
        task.transition("awaiting_approval")
        task.transition("running")
        self.assertEqual(task.status, "running")

    def test_terminal_states_are_final(self):
        task = Task(title="test", role="tester", prompt="test", command=["python", "--version"])
        task.transition("awaiting_approval")
        task.transition("running")
        task.transition("completed")
        with self.assertRaises(ValueError):
            task.transition("running")

    def test_cancelled_state_is_terminal(self):
        task = Task(title="test", role="tester", prompt="test", command=["python", "--version"])
        task.transition("awaiting_approval")
        task.transition("running")
        task.transition("cancelled")
        with self.assertRaises(ValueError):
            task.transition("running")

    def test_shell_is_blocked(self):
        runner = CommandRunner(["python", "cmd", "powershell"])
        with self.assertRaises(ValueError):
            runner.validate(["powershell", "-Command", "whoami"])

    def test_orchestrator_enforces_pipeline_dependencies(self):
        profiles = {
            role: {"command": ["python", "-c", "print('{task}')"]}
            for role in ("planner", "coder", "tester", "reviewer")
        }
        tasks = Orchestrator(profiles, "zskbot/ocodejs-cli").build_workflow("add feature")
        self.assertEqual(len(tasks), 4)
        self.assertEqual(tasks[0].depends_on, [])
        for index in range(1, len(tasks)):
            self.assertEqual(tasks[index].depends_on, [tasks[index - 1].id])


if __name__ == "__main__":
    unittest.main()
