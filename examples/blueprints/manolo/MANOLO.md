# Manolo repository Task

The workspace is a fresh Git worktree on branch `task/<task id>`, created from the configured base commit. Work and
commit there. Do not fetch, rebase, or switch the branch. To hand off a commit, push the exact branch to the configured
handoff remote; `finish` verifies the handed-off commit read-only and refuses a dirty worktree.
