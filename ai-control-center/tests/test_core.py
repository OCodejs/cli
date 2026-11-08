import unittest
from core.models import Task
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

    def test_shell_is_blocked(self):
        runner = CommandRunner(["python", "cmd", "powershell"])
        with self.assertRaises(ValueError):
            runner.validate(["powershell", "-Command", "whoami"])


if __name__ == "__main__":
    unittest.main()
