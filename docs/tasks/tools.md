# Task tools

The tool contract for the [Task lifecycle](README.md), as implemented in this checkout. Tools marked **shipped** exist
and are covered by tests; tools marked **proposed** are design only. All tools call the same task service as the web UI;
chat and worker transcripts are not a second source of truth.

## Orchestrator: plan and observe work

Offered only on a flagged web turn of an agent listed in `MANOLO_WORK_SESSION_AGENT`. Authority and owner come from that
turn's placed input; no tool accepts an owner, scope, or delivery destination.

| Tool | Status | Contract |
| --- | --- | --- |
| `create_task` | **Shipped** | Queue one task with a title, task text, optional pinned blueprint (from `inspect_manolo`), and optional `notBefore` ISO time. Returns the Task ID and current status without waiting. A future time makes it Scheduled until due. |
| `list_tasks` / `get_task` | **Shipped** | List or read this conversation's Tasks, including blueprint, latest progress, the open or answered Inbox item, and the terminal outcome. Filter by state, blueprint, or text. |
| `cancel_task` | **Shipped** | Cancel a non-terminal Task, close its pending Inbox item, and fence late execution updates. Does not undo external effects. |
| `list_blueprints` | **Proposed** | Blueprint discovery stays on `inspect_manolo` for now. |
| `create_trigger` / `list_triggers` / `disable_trigger` | **Proposed** | No trigger engine ships in this slice. |

## Task: execute and communicate about its own work

Offered only inside the Task's child execution. The Task ID and active execution claim come from the child conversation's
own record; the model cannot name either.

| Tool | Status | Contract |
| --- | --- | --- |
| `report_progress` | **Shipped** | Save a concise milestone without pausing. Visible in Task details; no conversation interruption. |
| `post_inbox` | **Shipped** | Open one typed **question** or **report for review**, park the Task, and release its execution slot. Returns the owner's response when it arrives. This is a yield boundary: the tool parks on a durable signal, a guard refuses every other tool in that execution, and the relay refuses progress, another item, or a settle from the yielded execution. |
| `get_task_context` | **Proposed** | The child receives its assignment, blueprint, and any response in its input and the tool result. |
| `propose_follow_up` | **Proposed** | Follow-up proposals do not ship; the Orchestrator creates Tasks itself. |

A worker's accepted result settles the current execution; a progress note, Inbox review, or follow-up proposal does not.
The notification path is separate from tool calls: the service records an event for an Inbox request or a Task outcome,
the chat shows it as a durable notice, and the next orchestrator turn receives undelivered notices once as data. The
Orchestrator does not have to poll `get_task` to learn that input is needed. An Inbox response goes to the Task, not
through model interpretation of a chat reply.

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
