from .models import Task


PIPELINE = [
    ("planner", "Lập kế hoạch triển khai"),
    ("coder", "Triển khai thay đổi"),
    ("tester", "Chạy kiểm thử và sửa lỗi"),
    ("reviewer", "Review bảo mật và chất lượng"),
]


class Orchestrator:
    """Builds a staged workflow; every stage waits for a human approval."""

    def __init__(self, agent_profiles, repository):
        self.profiles = agent_profiles
        self.repository = repository

    def build_workflow(self, brief):
        tasks = []
        for role, title in PIPELINE:
            profile = self.profiles.get(role)
            if not profile or not profile.get("command"):
                continue
            prompt = (
                f"Repository: {self.repository}\n"
                f"Role: {role}\n"
                f"Objective: {brief}\n"
                f"Instructions: {title}. Inspect existing project conventions. "
                "Do not expose secrets. Do not deploy, merge, or push. "
                "Report files changed, tests run, risks, and remaining work."
            )
            argv = [str(part).replace("{task}", prompt).replace("{repo}", self.repository)
                    for part in profile["command"]]
            tasks.append(Task(title=title, role=role, prompt=prompt, command=argv))
        return tasks
