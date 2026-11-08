from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import uuid


@dataclass
class Task:
    title: str
    role: str
    prompt: str
    command: list[str]
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    depends_on: list[str] = field(default_factory=list)
    status: str = "pending"
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    return_code: Optional[int] = None

    @property
    def elapsed_seconds(self) -> float:
        if not self.started_at:
            return 0.0
        end = self.finished_at or datetime.now()
        return max(0.0, (end - self.started_at).total_seconds())

    def transition(self, new_status: str) -> None:
        allowed = {
            "pending": {"awaiting_approval", "cancelled"},
            "awaiting_approval": {"running", "cancelled"},
            "running": {"completed", "failed", "cancelled"},
            "completed": set(),
            "failed": set(),
            "cancelled": set(),
        }
        if new_status not in allowed.get(self.status, set()):
            raise ValueError(f"Invalid task transition: {self.status} -> {new_status}")
        self.status = new_status
        if new_status == "running":
            self.started_at = datetime.now()
        if new_status in {"completed", "failed", "cancelled"}:
            self.finished_at = datetime.now()
