# GitHub operating policy

This is the trusted policy the worker puts in a Task's instructions, and the validation this service applies to a
structured remote. It is not shell enforcement: the pod has `git` and may have GitHub credentials, so a shell command
can do what the shell can do. The policy binds the model's instructions and the remotes the service itself accepts.

## Accounts and destinations

- `lanquarden` (personal) and `manolo-mistalibio` (agent) are **owned** accounts.
- Issues and pull requests to an owned account are allowed by default.
- A third-party destination needs the owner's explicit request. An owned fork as the source is not that permission.
- Forking a third-party repository and pushing scoped Task branches to a configured owned fork is allowed, whatever the
  upstream owner.

## Task handoff

A Blueprint repository may configure a `handoff` remote. It must be a local operator path or a GitHub remote owned by
`lanquarden` or `manolo-mistalibio`; another GitHub owner fails startup. A Task pushes its own `task/<task id>` branch
to that remote. `finish` verifies the branch and exact commit read-only.

Never push to `main`, merge, or deploy unless the owner explicitly asks. Merge stays a separate, explicit decision; this
slice has no merge or deployment action.

## Where it is enforced

| Place | Enforcement |
| --- | --- |
| Worker Task instructions | The trusted policy text is prepended to every Task child. |
| Blueprint load | A non-owned GitHub `handoff` remote is rejected. |
| Task Git | Only `task/<task id>` is created, checked, and handed off; the finish check is read-only. |
| Shell | Not enforceable here. The model is told the policy; the shell is not a sandbox. |

A structured issue/PR tool is not shipped. `validateGitHubDestination` encodes the owned/third-party rule for when one
is added.
