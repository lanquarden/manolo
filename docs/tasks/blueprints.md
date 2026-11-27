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
symlink that resolves outside it, duplicate ids (including two members with the same name in the raw JSON, which
`JSON.parse` would silently collapse), duplicate tools, a base branch that is not a valid Git ref (`main//release`,
`release/`, `..`), more than 24 Blueprints, or a missing lifecycle tool fails startup. Every `role: "task"` Blueprint lists `report_progress`, `post_inbox`, and `finish` explicitly. A tool name
that is not installed on the worker fails that dispatch; nothing falls back to the default tool set.

`role` is `task` or `conversation`. At most one conversation Blueprint exists; it supplies context for the main
conversation and is never offered as a delegation target. The sample bundle in
[`examples/blueprints/manolo`](../../examples/blueprints/manolo) includes the conversation Blueprint, a generic Task, and
a Manolo repository Task.

The legacy `MANOLO_WORK_BLUEPRINTS` text map still loads and keeps the old behavior: no explicit tool set and no
profile. Duplicate ids between the two formats are refused.

## Conversation Blueprint

The single `role: "conversation"` Blueprint supplies the main conversation's instructions, resolved model profile, and
optional exact tools. It is re-read for each new turn: an operator edit applies to the next turn, while a retry of an
already-admitted turn keeps the settings and history it was admitted with. If the selection changes while another run is
live, the new turn is refused until the session is idle. An unavailable profile or tool fails the new turn rather than
substituting another.

The three selections are applied explicitly, so removing one resets the conversation instead of leaving the previous
value behind: an omitted or `null` tool list restores the worker's default tool set, an empty list offers no tools, and a
removed profile clears the stored reasoning level back to the worker default.

A conversation Blueprint is never a delegation target. Only legacy text Blueprints are offered to `delegate_work`; a
configured Task bundle cannot run as an ungoverned work-session child.

## Pinning and revision

A Task pins a **snapshot** at creation: role, description, rendered instruction text, exact tool names, the resolved
profile values, the resolved repository values, and file hashes. The revision is the SHA-256 of that canonical content,
so editing a file or profile is a new revision. The relay stores the snapshot; dispatch reads the snapshot, not a
mutable path. A Task queued before an edit keeps its old text and policy, and a retry keeps its history.

A saved snapshot is self-contained: it survives an edit or removal of the manifest Blueprint, and of the named profile
it pinned. The worker validates the pinned provider, model, and reasoning level against the catalog it can actually
reach, never against a current alias, and never substitutes. An unavailable pinned profile, unknown tool, invalid
repository, or missing worktree blocks the Task with a visible reason and the same execution identity; restoring the
worker or workspace resumes it.

A new-style assignment (a pinned snapshot, profile, review binding, or finish protocol) is dispatched to the versioned
route `POST /v1/tasks/<id>/executions/v2`, and only that route accepts it. The plain `/executions` route refuses such a
body. A worker replaced between the `/v1/task-protocol` probe and the dispatch therefore cannot accept the assignment
with substituted defaults, and the relay never retries it on the old path: it blocks and holds the same execution.
Legacy tasks without those fields still use the old dispatch path.

## Profiles

Profiles are resolved against the models the worker can actually reach at startup. An unresolvable profile is dropped,
and Task Blueprints that reference it are not discoverable. A profile may name a provider; it must match the worker's
configured provider (or `model-proxy`). A different provider requires its own worker deployment, not a silent fallback.

The `model-proxy` catalog is authoritative. The worker reads the proxy's OpenAI-compatible `GET /v1/models` at startup
and advertises only the ids it lists; a configured alias the proxy does not serve is not offered, its profile is
dropped, and a Blueprint pinned to it is not discoverable. A configured default model that the catalog omits fails
startup. A proxy that cannot answer the catalog request serves only the explicitly configured default model, so no
unverified alias is ever advertised. The same set is what `create_task`, `inspect_manolo`, the capability API, and the
Tasks view see.

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
actionable error instead of ending a dirty or unverifiable Task. Acceptance is a **one-way durable boundary**:

- the relay stores the finish receipt and evidence; the worker's final turn then settles the Task;
- a replay after acceptance reads the relay receipt or the worker's marker without sampling Git again, so a workspace
  change after a lost acknowledgement cannot block recovery;
- a later failure settle cannot downgrade it, and no further `post_inbox`, progress, or other tool call runs. The yield
  guard blocks every tool after acceptance except an idempotent `finish` replay;
- an explicit cancellation after acceptance is still the owner's terminal decision; a success settle from the stopped
  execution is refused;
- an accepted finish also settles a Task whose execution has since disappeared. A lost resume acknowledgement, an
  `unknown_execution` reply, or an exhausted dispatch retry budget is reconciled from the receipt (and from the
  worker's own delivery receipt for an Inbox item), never turned into a failure;
- a required pull request is structural evidence: canonical `https://github.com/<owner>/<repository>/pull/<number>`, the
  accepted commit, and — when the repository has a GitHub destination — exactly that destination. A URL that only
  becomes canonical after normalization is refused. No live GitHub request is made.

A final turn without `finish` is never success. The first one gets exactly one durable corrective turn in the same Task
and session; a second one fails the Task. The counter lives in the execution record, so a worker restart does not grant
another correction. The relay refuses a success settle for a finish-required Task that has no finish acceptance.
Tasks created before this protocol keep the legacy settle behavior so a queued or in-flight Task is not stranded.

Settlement is confirmed from the relay, not assumed. A 409, timeout, or exhausted retry budget leaves the local
execution non-terminal and preserves the workspace; a restart replays the same settle. Cleanup runs only after an
authoritative done/failed/cancelled state, and only a successfully handed-off or untouched tree is removed. Clean
detached work, worktrees switched to another branch, unhanded commits, dirty work, and local-only scratch files are
preserved with recovery metadata.

## Repository Tasks and worktrees

A Blueprint repository binding is operator-managed. On the first execution the worker:

1. clones/fetches the configured remote into a per-process bare mirror, and resolves the exact base commit;
2. records that SHA and creates `task/<task id>` plus a persistent Git worktree under the worker data directory;
3. records the worktree path in the execution record and uses it as the file/shell cwd.

A retry or resume reuses the same worktree with no fetch or rebase. The worktree must prove its identity: the recorded
mirror, branch, repository hash, and Git toplevel all have to match. A missing worktree, a replaced path, or a switched
branch blocks recoverably with a visible reason; it is never re-created or silently switched. Dispatch, resume, and
every Task tool check this identity. While a run is live, a workspace that disappears or is switched is reported as a
recoverable block: the Task does not spend its corrective turn or fail, the reason is shown in the Tasks list and detail,
and once the recorded path is restored the same execution continues in the same conversation.

Two Tasks in one repository get independent worktrees *and* independent Git common dirs. The shared seed mirror
(`<remote hash>.git`) is a read-only object store: the worker fetches it, never checks it out, and it carries no Task
remote. Each Task gets its own persistent bare clone (`task-<task id>.git`) seeded from that store with a local clone,
so its worktree, refs, `git stash`, hooks, and config cannot be read or rewritten by another Task. Only the service's
short admin operations (fetch, worktree add/remove) serialize, never Task runs. A record written before per-Task clones
keeps its existing worktree and Git directory in place rather than being migrated and risking data.

A Task's handoff destination is metadata, not a named remote in its clone, so creating Task B cannot rewrite Task A's
push destination. The child receives the exact handoff URL and its `task/<task id>` branch in its instructions.

A **review Task** binds a finished source Task's exact handed-off commit and comparison base. It gets its own worktree
on branch `review/<task id>` at that commit, never a mutable branch tip, and it does not depend on the current upstream
base branch still existing: the pinned commit and base are objects. If upstream advanced, renamed, or deleted the base
ref, an object already in the store still opens the review; a commit that no configured remote can provide fails
`review_commit_missing` rather than falling back to the tip. Its finish evidence and instructions record the source Task,
both SHAs, the source branch, and the handoff remote. The Orchestrator and Task history expose the same evidence.

When an assignment explicitly requires a pull request, `finish` fails closed without a structured GitHub pull-request
URL bound to the accepted commit. This is evidence validation, not a live GitHub API check; no pull request is
published automatically.

The worktree is a working arrangement, not a security boundary. The shell is not a sandbox: it can run installed
binaries and read credentials the pod exposes. No external worktree setup hook runs.

`finish` is read-only. It rejects a dirty worktree, including untracked files, and it reports ignored files as well
(`--ignored=matching`, including output in nested directories that a plain status omits): it never deletes them, so the
child must move or remove what it no longer needs (`git clean -fdX` after checking) before finishing. Cleanup preserves
a worktree that still holds ignored work instead of removing files Git does not track. An unchanged worktree may finish
without a handoff. A commit beyond base must already be on the configured handoff remote at the Task branch and match `HEAD`
exactly; the check runs `ls-remote`, it never commits, pushes, resets, or deletes. After a terminal outcome, cleanup
removes only a clean worktree that is still on its recorded Task branch and leaves a tombstone; dirty, switched, or
local-only work is preserved with the recorded branch and commit.

Review handoff targets the exact Task branch commit, not a mutable branch. A pull request is created only when the owner
asks; this slice has no automated PR creation or live GitHub verification.

## Remaining gaps

These are measured limits of this slice, not silent downgrades:

- No automated pull-request creation, merge, or deployment. `finish` records the exact handed-off commit, branch, and
  remote, but a PR is still an owner action.
- Pull-request evidence is structural (URL plus commit), not a live GitHub API verification. The Task fails closed
  when the required evidence is missing.
- A review binding needs a finished source Task with recorded handoff evidence. A read-only source with no commit has
  nothing to review.
- Profiles resolve within the worker's configured provider catalog (or proxy catalog). A profile naming another provider
  is dropped, so it is not discoverable; a Task pinned to it is refused.
- Terminal cleanup is opportunistic in the worker that observes the terminal outcome. A worker crash before cleanup
  leaves the worktree and tombstone untouched for recovery; nothing recreates it.
- A mixed-version rollout needs `MANOLO_TASK_FINISH=legacy` until every worker can call `finish`; then return it to
  `required`. Only genuinely pre-upgrade rows (migrated with `finish_required=0`) keep the legacy settle behavior. A
  structured new-style Task always records `finish_required=1` and its pull-request evidence, whatever the rollout mode.
- A worktree preserved for ignored or unhanded work stays until an operator removes it, because cleanup is
  opportunistic. A workspace lost repeatedly stops continuing after five attempts.

## Wiring and rollout

Worker environment:

| Variable | Meaning |
| --- | --- |
| `MANOLO_BLUEPRINTS_DIR` | Bundle directory with `manifest.json`. |
| `MANOLO_WORK_BLUEPRINTS` | Legacy text map; still accepted beside a bundle directory. |
| `MANOLO_PROVIDER`, `MANOLO_MODEL`, `MANOLO_THINKING_LEVEL` | Default model and reasoning when no profile applies. |
| `MANOLO_MODEL_PROXY_URL`, `MANOLO_MODEL_PROXY_KEY` | Proxy runtime; profile model ids are added to its catalog. |
| `MANOLO_TASK_FINISH` | Relay-side finish enforcement. `required` (default) refuses a success settle with no finish. `legacy` is only for a mixed-version rollout with a worker that predates `finish`. |
| `/v1/task-protocol` | Worker capability handshake. Version 2 is required before a new-style snapshot/profile/review/finish assignment is sent, and the assignment itself goes to the versioned `/v1/tasks/<id>/executions/v2` route. |

The Task surfaces remain gated by `MANOLO_WORK_SESSION_AGENT`. An unconfigured worker keeps its old default model, no
Blueprint, and the default tool set, but still requires `finish` for new Tasks. Drop `MANOLO_BLUEPRINTS_DIR` to return to
the legacy behavior without changing the ledger; pinned snapshots already stored on Tasks remain runnable.

The Helm chart wires the same settings with safe defaults. `agents.<id>.blueprintsDir` points at a bundle directory
already inside the container; `agents.<id>.blueprintsMount.configMap` or `.secret` renders an operator-owned bundle
read-only at `/blueprints` and sets `MANOLO_BLUEPRINTS_DIR` for that worker. The two are mutually exclusive, a mount
name must be a Kubernetes object name, and unset means no bundle and no extra volume. `taskFinish` sets the relay's
`MANOLO_TASK_FINISH` (`required` or `legacy`, and `legacy` only with Tasks enabled). A configured directory without a
readable `manifest.json` fails worker startup, and `test/deploy-blueprints.test.mjs` renders and validates the chart.
