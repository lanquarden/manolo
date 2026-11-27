# Task tools

The tool contract for the [Task lifecycle](README.md), as implemented in this checkout. Tools marked **shipped** exist
and are covered by tests; tools marked **proposed** are design only. All tools call the same task service as the web UI;
chat and worker transcripts are not a second source of truth.

## Orchestrator: plan and observe work

Offered only on a flagged web turn of an agent listed in `MANOLO_WORK_SESSION_AGENT`. Authority and owner come from that
turn's placed input; no tool accepts an owner, scope, or delivery destination.

| Tool | Status | Contract |
| --- | --- | --- |
| `create_task` | **Shipped** | Queue one task with a title, task text, optional Blueprint and named model profile, optional `reviewOf` a finished Task's exact handed-off commit, optional `requiresPullRequest`, and optional `notBefore` ISO time. The resolved Blueprint text, tools, profile, and repository are pinned as a content-addressed snapshot. Returns the Task ID and current status without waiting. A future time makes it Scheduled until due. |
| `list_tasks` / `get_task` | **Shipped** | List or read this conversation's Tasks, including blueprint, latest progress, the open or answered Inbox item, and the terminal outcome. Filter by state, blueprint, or text. |
| `cancel_task` | **Shipped** | Cancel a non-terminal Task, close its pending Inbox item, and fence late execution updates. The ledger cancellation and the retried worker stop are reported separately. Does not undo external effects. |
| `list_blueprints` | **Proposed** | Discovery stays on `inspect_manolo`, which lists task Blueprints and their short descriptions plus resolvable profiles. |
| `create_trigger` / `list_triggers` / `disable_trigger` | **Proposed** | No trigger engine ships in this slice. |

## Task: execute and communicate about its own work

Offered only inside the Task's child execution. The Task ID and active execution claim come from the child conversation's
own record; the model cannot name either.

| Tool | Status | Contract |
| --- | --- | --- |
| `report_progress` | **Shipped** | Save a concise milestone without pausing. Visible in Task details; no conversation interruption. |
| `finish` | **Shipped** | The only success path and a one-way durable boundary. Validates the Task workspace read-only (dirty/untracked work and an unverified handoff commit are refused with an actionable error), records replay-stable finish evidence, and blocks all later tools/progress/Inbox work. A lost acknowledgement is reconciled from relay state without resampling Git. A required pull request must carry a URL bound to the accepted commit. A bare final turn gets one corrective turn in the same session; a second one fails the Task. |
| `post_inbox` | **Shipped** | Open one typed **question** or **report for review**, park the Task, and release its execution slot. Returns the owner's response when it arrives. This is a yield boundary: the tool parks on a durable signal, a guard refuses every other tool in that execution, and the relay refuses progress, another item, or a settle from the yielded execution. |
| `get_task_context` | **Proposed** | The child receives its assignment, blueprint, and any response in its input and the tool result. |
| `propose_follow_up` | **Proposed** | Follow-up proposals do not ship; the Orchestrator creates Tasks itself. |

An accepted `finish` plus the end of the final turn settles the current execution; a progress note, Inbox review, or bare final turn does not.
The notification path is separate from tool calls: the service records an event for an Inbox request or a Task outcome,
the chat shows it as a durable notice, and the next orchestrator turn receives undelivered notices once as data. The
Orchestrator does not have to poll `get_task` to learn that input is needed. An Inbox response goes to the Task, not
through model interpretation of a chat reply.

## Blocked and recovered

A running Task can be blocked on a recoverable condition: an unavailable model profile, a missing tool, a lost or
replaced worktree, or a worker that predates the Task protocol. The row stays running with a `blocked` reason and the
same execution identity; restoring the worker/profile/workspace resumes it. The relay never substitutes another model,
tool set, or workspace.

## Blueprint and workspace

A Task child receives only its pinned Blueprint text, the trusted GitHub policy, and its assignment. Tools are the
explicit manifest list plus nothing inherited; an unknown name fails closed. A repository Blueprint gets its own
persistent worktree on `task/<task id>`; every other Task gets its own scratch directory. See
[Blueprints, profiles, and Task workspaces](blueprints.md) for the format, precedence, finish gate, and shell boundary.

## Authority and replay

- Owner and conversation scope are bound from the authenticated Orchestrator turn; Task ID and execution claim from the
  worker context. A task tool does not accept an arbitrary owner, Task ID, or delivery destination from the model.
- Mutating calls carry replay-stable operation IDs. A retried call returns the existing receipt, not another task, Inbox
  item, or notice. A new intentional call is a separate operation. The Task mutation and its pending notice commit
  together; transport delivery is at-least-once.
- A stale execution cannot post progress, open an Inbox item, or settle the Task after yielding or cancellation. An exact
  retry of an already committed operation may read its receipt without changing state.
- Default authority split: Tasks **propose** follow-ups; the Orchestrator **creates** them within the user's scope.
  Recurring schedules and event triggers stay with the Orchestrator.
