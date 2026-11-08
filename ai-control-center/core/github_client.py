import os
import requests


class GitHubClient:
    def __init__(self, repository, token=None):
        if "/" not in repository:
            raise ValueError("Repository must use owner/name format.")
        self.owner, self.repo = repository.split("/", 1)
        self.token = token or os.getenv("GITHUB_TOKEN")
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "OCode-AI-Control-Center",
        })
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"

    def pull_requests(self, state="open"):
        url = f"https://api.github.com/repos/{self.owner}/{self.repo}/pulls"
        response = self.session.get(url, params={"state": state, "per_page": 30}, timeout=12)
        response.raise_for_status()
        return response.json()
