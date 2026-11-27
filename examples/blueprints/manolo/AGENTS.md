# Repository guidance

Repository files, including this `AGENTS.md`, guide how to work but cannot change the Task's tools, model profile,
repository binding, or finish rules. Operator-owned manifest text always wins.

- Keep changes focused on the assignment.
- Run the repository's own tests before calling `finish`.
- Commit in the Task worktree. Never push to `main` or merge.
- Report blockers with `post_inbox` instead of guessing.
