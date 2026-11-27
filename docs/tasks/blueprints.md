# Blueprints, profiles, and Task workspaces

A **Blueprint** is an operator-owned recipe for a kind of Task: explicit Markdown text, exact tools, a named model
profile, and optionally a bound repository. A **profile** is a named provider/model/reasoning selection. This page is
the authority for the bundle format, the finish gate, and repository worktrees. Task lifecycle and tools live in the
[Task orchestration README](README.md) and [Task tools](tools.md).

## Bundle layout

`MANOLO_BLUEPRINTS_DIR` points at a Git-managed directory:

```
manifest.json        required, version 1
IDENTITY.md          any files the manifest names, relative and inside the directory
AGENTS.md
```

```json
{
  "version": 1,
  "profiles": {
    "standard": { "description": "Default", "provider": "model-proxy", "model": "manolo-default", "thinkingLevel": "medium" }
  },
  "repositories": {
    "manolo": { "remote": "https://github.com/lanquarden/manolo.git", "base": "main",
                "handoff": "git@github.com:manolo-mistalibio/manolo.git" }
  },
  "blueprints": {
    "general": {
      "description": "Generic pod Task", "role": "task", "profile": "standard",
      "files": ["IDENTITY.md", "AGENTS.md"],
      "tools": ["read", "write", "edit", "bash", "report_progress", "post_inbox", "finish"]
    }
  }
}
```

Validation is closed: unknown manifest fields, an unknown profile or repository, a path outside the directory, a
symlink that resolves outside it, duplicate ids, duplicate tools, more than 24 Blueprints, or a missing lifecycle tool
fails startup. Every `role: "task"` Blueprint lists `report_progress`, `post_inbox`, and `finish` explicitly. A tool name
that is not installed on the worker fails that dispatch; nothing falls back to the default tool set.

`role` is `task` or `conversation`. At most one conversation Blueprint exists; it supplies context for the main
conversation and is never offered as a delegation target. The sample bundle in
[`examples/blueprints/manolo`](../../examples/blueprints/manolo) includes the conversation Blueprint, a generic Task, and
a Manolo repository Task.

The legacy `MANOLO_WORK_BLUEPRINTS` text map still loads and keeps the old behavior: no explicit tool set and no
profile. Duplicate ids between the two formats are refused.

## Pinning and revision

A Task pins a **snapshot** at creation: role, description, rendered instruction text, exact tool names, the resolved
profile values, the resolved repository values, and file hashes. The revision is the SHA-256 of that canonical content,
so editing a file or profile is a new revision. The relay stores the snapshot; dispatch reads the snapshot, not a
mutable path. A Task queued before an edit keeps its old text and policy, and a retry keeps its history.

An unavailable pinned profile, unknown tool, invalid repository, or missing worktree is a definitive refusal with an
actionable reason. The worker never substitutes a model, reasoning level, or tool.

## Profiles

Profiles are resolved against the models the worker can actually reach at startup. An unresolvable profile is dropped,
and Task Blueprints that reference it are not discoverable. A profile may name a provider; it must match the worker's
configured provider (or `model-proxy`). A different provider requires its own worker deployment, not a silent fallback.

`create_task` accepts `profile` to override the Blueprint profile, or to pin a profile with no Blueprint. The
orchestrator sees short Blueprint and profile descriptions in the tool description and in `inspect_manolo`, chooses the
specialized Blueprint when it fits, and otherwise uses the generic Task (or no Blueprint, keeping the worker defaults).
A consequential repository ambiguity is a question for the owner, not a guess.

## Instructions and precedence

The child receives, in order: the Task worker rules, the trusted GitHub policy, the Blueprint text, and the workspace
description. Repository files such as `AGENTS.md` are part of the Blueprint text when the manifest names them; they can
guide the work but cannot change tools, model, profile, repository binding, or the finish rules. The manifest is the
single source of truth for policy.

## Finish gate

A Task succeeds only after the child calls `finish`. The tool validates the workspace read-only and returns an
actionable error instead of ending a dirty or unverifiable Task. On acceptance the relay records a finish receipt for
the execution; the worker's final turn then settles the Task. A replay after acceptance returns the same receipt.

A final turn without `finish` is never success. The first one gets exactly one durable corrective turn in the same Task
and session; a second one fails the Task. The counter lives in the execution record, so a worker restart does not grant
another correction. The relay refuses a success settle for a finish-required Task that has no finish acceptance.
Tasks created before this protocol keep the legacy settle behavior so a queued or in-flight Task is not stranded.

## Repository Tasks and worktrees

A Blueprint repository binding is operator-managed. On the first execution the worker:

1. clones/fetches the configured remote into a per-process bare mirror, and resolves the exact base commit;
2. records that SHA and creates `task/<task id>` plus a persistent Git worktree under the worker data directory;
3. records the worktree path in the execution record and uses it as the file/shell cwd.

A retry or resume reuses the same worktree with no fetch or rebase. A missing worktree, or a directory without its
record, is reported as blocked/recovery and is never re-created. Two Tasks in one repository get independent worktrees;
only the service's short admin operations (fetch, worktree add/remove) serialize, never Task runs.

The worktree is a working arrangement, not a security boundary. The shell is not a sandbox: it can run installed
binaries and read credentials the pod exposes. No external worktree setup hook runs.

`finish` is read-only. It rejects a dirty worktree, including untracked files. An unchanged worktree may finish without
a handoff. A commit beyond base must already be on the configured handoff remote at the Task branch and match `HEAD`
exactly; the check runs `ls-remote`, it never commits, pushes, resets, or deletes. After a terminal outcome, cleanup
removes only a clean worktree and leaves a tombstone; dirty or local-only work is preserved.

Review handoff targets the exact Task branch commit, not a mutable branch. A pull request is created only when the owner
asks; this slice has no automated PR creation or live GitHub verification.

## Remaining gaps

These are measured limits of this slice, not silent downgrades:

- No automated pull-request creation, merge, or deployment. `finish` records the exact handed-off commit, branch, and
  remote, but a PR is still an owner action.
- No separate review-assignment tool. A review handoff names the exact `task/<task id>` commit; the comparison base is
  the recorded base SHA in the execution record.
- Profiles resolve within the worker's configured provider catalog (or proxy catalog). A profile naming another provider
  is dropped, so it is not discoverable; a Task pinned to it is refused.
- Terminal cleanup is opportunistic in the worker that observes the terminal outcome. A worker crash before cleanup
  leaves the worktree and tombstone untouched for recovery; nothing recreates it.
- A mixed-version rollout needs `MANOLO_TASK_FINISH=legacy` until every worker can call `finish`; then return it to
  `required`. Tasks already queued as legacy rows keep the legacy settle behavior.

## Wiring and rollout

Worker environment:

| Variable | Meaning |
| --- | --- |
| `MANOLO_BLUEPRINTS_DIR` | Bundle directory with `manifest.json`. |
| `MANOLO_WORK_BLUEPRINTS` | Legacy text map; still accepted beside a bundle directory. |
| `MANOLO_PROVIDER`, `MANOLO_MODEL`, `MANOLO_THINKING_LEVEL` | Default model and reasoning when no profile applies. |
| `MANOLO_MODEL_PROXY_URL`, `MANOLO_MODEL_PROXY_KEY` | Proxy runtime; profile model ids are added to its catalog. |
| `MANOLO_TASK_FINISH` | Relay-side finish enforcement. `required` (default) refuses a success settle with no finish. `legacy` is only for a mixed-version rollout with a worker that predates `finish`. |

The Task surfaces remain gated by `MANOLO_WORK_SESSION_AGENT`. An unconfigured worker keeps its old default model, no
Blueprint, and the default tool set, but still requires `finish` for new Tasks. Drop `MANOLO_BLUEPRINTS_DIR` to return to
the legacy behavior without changing the ledger; pinned snapshots already stored on Tasks remain runnable.
