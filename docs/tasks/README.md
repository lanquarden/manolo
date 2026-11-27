# Task orchestration

**Status:** the first durable slice ships in this checkout; the rest of the agreed direction is still design. See
[What ships](#what-ships) and [Deferred](#deferred). The [checked models](#checked-models) describe the agreed
lifecycle; they are not a checked distributed implementation.

See [Task tools](tools.md) for the Orchestrator and worker tool contract as implemented.

## Lifecycle

- Web chat and messaging talk to an Orchestrator. It creates and looks up Tasks in a durable ledger rather than inferring
  state from the transcript. Every delegation creates a Task; casual chat need not. The originating conversation is a
  notification destination, not the execution owner.
- Creation pins the blueprint revision and queues the Task. “Run now” is eligibility now, not a second dispatch route. A
  future not-before time and unresolved dependencies can each keep a Task from being eligible. A dependent Task normally
  requires upstream success; an explicit **any terminal outcome** dependency also accepts failure or cancellation.
  Waiting for input is never a terminal outcome.
- The scheduler claims eligible work. Opening a question or submitting a report for review changes the Task to **waiting
  for input** and releases its scheduler slot. Save the open Inbox item and pending notification durably with the pause.
  Progress updates and completion summaries are non-blocking.
- The Orchestrator surfaces the notification in the originating conversation. In messaging, relay a short summary and a
  link to the authorized web Inbox item. Messaging replies are not Inbox responses in v1. A web response closes its item
  and queues the **same Task**; it does not settle the Task. An identical response retry returns the recorded receipt,
  without another execution; a conflicting or stale response cannot advance the Task.
- Completed, failed, and cancelled Tasks are terminal. Cancellation closes any pending item and fences off late worker
  results. Cancellation stops further Task progression; it does not promise that actions already dispatched to external
  systems were stopped or undone.
- A recurring schedule or event Trigger creates a fresh Task for each distinct occurrence. Dedupe admission on
  `(trigger ID, occurrence ID)`, not on blueprint or message text. An outgoing notification does not match an inbound
  message trigger. Scheduling one existing Task for Friday sets its not-before time; it is not a Trigger that creates
  another Task.
- The user-facing work list is Tasks grouped by blueprint identity across revisions. Execution history lives inside Task
  details. Grouping and history retention do not define the scheduler's authority or change eligibility.

## What ships

One durable path, end to end, for flagged web conversations. Everything below is implemented and covered by
[`test/task-flow.test.mjs`](../../test/task-flow.test.mjs) and [`test/web-tasks.test.mjs`](../../test/web-tasks.test.mjs).

| Piece | Where |
| --- | --- |
| Task ledger, scheduler claim, Inbox items, progress, operation receipts, notices | [`src/task-store.mjs`](../../src/task-store.mjs) (SQLite tables on the relay database) |
| Orchestrator tools `create_task`, `list_tasks`, `get_task`, `cancel_task` | [`src/task-tools.mjs`](../../src/task-tools.mjs#L66) |
| Worker tools `report_progress`, `post_inbox` and the yield guard | [`src/task-tools.mjs`](../../src/task-tools.mjs#L230), [guard](../../src/task-tools.mjs#L276) |
| One child execution per Task, parked on a signal, reattached after restart | [`dispatch`](../../src/task-tools.mjs#L376), [`resume`](../../src/task-tools.mjs#L432) |
| Scheduler loop and dispatch/resume delivery | [`src/relay.mjs`](../../src/relay.mjs#L1065) |
| Internal worker API for executions, resumes, cancels, transcripts | [`src/worker.mjs`](../../src/worker.mjs#L513) |
| Web API for tasks, task items, cancellation and notices | [`src/relay.mjs`](../../src/relay.mjs#L697) |
| Tasks view: active tree, history filters, detail, chat notices | [`src/web/app.js`](../../src/web/app.js#L1315), [`src/web/index.html`](../../src/web/index.html) |

### Flow, as implemented

1. A flagged web turn calls `create_task`. The worker derives the turn and conversation scope from its own placed input
   and posts to the relay with a replay-stable operation key. The relay stores one `queued` row with the pinned
   blueprint revision, an optional not-before time, and the originating client turn ID. It returns the Task ID without
   waiting for execution.
2. The relay scheduler claims one eligible `queued` row at a time, mints an execution ID in the same transaction, and
   dispatches it to the worker. A retry of that dispatch keeps the execution ID, so the worker admits the same child
   submission rather than a second one.
3. The worker creates one ownerless child conversation, applies the pinned blueprint (refusing a revision it no longer
   has), and admits the task input. The child has only `report_progress` and `post_inbox` on top of its normal pod tools.
4. `post_inbox` writes the item and parks the Task in one relay transaction: the Task becomes `waiting`, its claim is
   released, and a durable notice is recorded. The tool then parks on a pi-durable signal and holds no process. The
   worker's yield guard refuses every other tool call in that execution, and the relay refuses progress, another item,
   or a settle from it.
5. A web Inbox response is the only transition out of `waiting`. One SQLite transaction closes the item, stores the
   response, and queues the **same Task** with `execution_kind='resume'`; an identical retry returns the recorded
   receipt, a conflicting one is refused, and no chat turn is inserted. The scheduler claims it and delivers the
   response to the parked call by execution ID. The run continues in the same child conversation, and its final message
   settles the Task.
6. If the parked call is gone (for example a worker volume was lost), the delivery reports `no_parked_call`, the relay
   queues a fresh execution, and the response travels in the child input instead of being lost.
7. Every Task event (waiting, response, outcome) is a durable notice scoped to the originating conversation. The chat
   shows them as recorded notices, and the next orchestrator turn receives undelivered ones as data in its instructions,
   once. `list_tasks` and `get_task` remain the authoritative read path; the model never polls to learn that input is
   needed.

### Atomic boundaries

- **Task creation:** one insert with its operation receipt.
- **Claim:** `queued → running` with the execution ID in one transaction, so a Task is never claimed twice and a
  dispatch retry cannot mint a second execution.
- **Park:** item insert, `waiting` transition, claim release, and notice in one transaction. A replayed park returns the
  same item; a second open item is refused.
- **Response:** item close, stored response, `queued` resume transition, and notice in one transaction. Retries are
  receipts; conflicts are refused.
- **Settle and cancel:** a terminal transition with its notice, fenced by the current execution ID.

Everything else is at-least-once and idempotent by operation key: dispatch, resume delivery, progress, settle, and the
next-turn notice exposure. Delivery is not exactly-once transport.

### Rollout and reversal

- The ledger lives in the relay's existing SQLite database. Tables are created on startup with `CREATE TABLE IF NOT
  EXISTS`, so an older database gains them in place and an older relay ignores them.
- The slice is gated by the existing `MANOLO_WORK_SESSION_AGENT` list: without it, `/api/tasks` is 404, the internal
  task routes are 404, and no turn is flagged for orchestration tools. No chart change is required.
- Reversal: drop `MANOLO_WORK_SESSION_AGENT` (or the agent from it) and the Task surfaces disappear while existing rows
  stay for a later re-enable. Deleting the five `task*` tables removes the ledger; queued Tasks are then lost, so drain
  or cancel them first.
- The Tasks view is additive. The legacy Sessions view and `/api/sessions` are unchanged, so old work sessions stay
  readable even though they are not Tasks.

## Deferred

Not implemented in this slice, and not implied by the UI:

- Messaging (Telegram/Discord) notification or delegation of Tasks; messaging replies are not Inbox responses.
- Recurring schedules and event Triggers, occurrence admission keys, and catch-up/DST policy.
- Dependencies between Tasks, fork/auto follow-up creation, and the proposed `propose_follow_up` tool.
- Multiple concurrent executions of one Task, lease-based recovery of a lost worker (a Task whose worker never returns
  stays `running` until the owner cancels it), and graph-wide cycle handling.
- Declined-item policy beyond "the child is told the item was declined and continues".
- Migrating legacy work sessions into Tasks.

## Checked models

| Model | What TLC checked | Reachable states |
| --- | --- | ---: |
| [`TaskFlow`](model/TaskFlow.tla), lifecycle and dependency views | No early claim, slot released when not running, one open item only while waiting, no extra run from replayed input, dependency outcome gate, stale execution cannot publish a result, terminal state stays terminal. | 72 |
| [`InboxRouting`](model/InboxRouting.tla) | Questions and reports, not progress, require input; a publish creates a logical notice; responses only through web Inbox; notices stay in the originating conversation. | 33 |
| [`Triggers`](model/Triggers.tla) | No admission before the time is due or a matching message is present, one Task per occurrence, and admission keys remain recorded. | 63 |

These are separate projections, not a checked distributed implementation. They cover up to two pauses on one Task, one
dependent Task through its first claim, one Inbox publication, two messaging destinations, and two occurrences per
trigger source. The views hide modeled no-ops and transitions irrelevant to the selected view. The trigger view shows
occurrence one per source. Responses and delivery may happen independently. Terminal or idle states can wait; safety
checks do not prove eventual execution or delivery. The models do not check DB transactions, authorization, transport
duplicate delivery, external side effects, checkpoint replay, lease recovery, graph-wide cycle handling, trigger
catch-up/DST, or policy on declined/expired Inbox items.

### Rerun

From the repo root, with the statechart skill runner installed locally (set `STATECHART` to its absolute path if
installed elsewhere):

```bash
(
  set -e
  runner=${STATECHART:-$HOME/.agents/skills/statechart/scripts/statechart}
  scratch=$(mktemp -d)
  cp docs/tasks/model/* "$scratch/"
  cd "$scratch"
  "$runner" TaskFlow.tla --config TaskFlow.cfg --view task-view.mjs --out lifecycle
  "$runner" TaskFlow.tla --config TaskFlow.cfg --view follower-view.mjs --out dependency
  "$runner" InboxRouting.tla --config InboxRouting.cfg --view inbox-view.mjs --out inbox
  "$runner" Triggers.tla --config Triggers.cfg --view trigger-view.mjs --out triggers
  printf 'Mermaid, reports and TLC logs: %s\n' "$scratch"
)
```

## Code audit

| Target transition | Current checkout | Evidence |
| --- | --- | --- |
| Conversation delegates a Task and later reads status | **Shipped** for flagged web turns: `create_task` pins the blueprint revision, returns a durable Task ID, and `list_tasks`/`get_task` read it back. The legacy `delegate_work` path still launches a work session whose ID derives from the parent turn. | [`src/task-tools.mjs`](../../src/task-tools.mjs#L66), [`src/task-store.mjs`](../../src/task-store.mjs#L66), [task flow test](../../test/task-flow.test.mjs) |
| Task waits for a web Inbox answer/review and resumes by Task ID | **Shipped.** `post_inbox` parks the child execution; the web response queues the same Task and resumes the same child conversation by execution ID. The legacy parent question still queues a continuation turn in the original chat. | [`post_inbox`](../../src/task-tools.mjs#L230), [`respond`](../../src/task-store.mjs#L355), [`resume`](../../src/task-tools.mjs#L432) |
| Messaging Orchestrator relays the Task's Inbox item in the originating thread | **Missing.** Message jobs deliver ordinary replies; Task notices reach the web conversation only. | [`src/relay.mjs`](../../src/relay.mjs#L973) |
| Task scheduler gates claims, applies dependencies, cancels work, admits triggers | **Partial.** Claims, not-before eligibility, one execution at a time, fencing and cancellation ship. Dependencies and triggers do not. | [`claim`](../../src/task-store.mjs#L243), [`runTask`](../../src/relay.mjs#L1065) |
| Tasks view groups work by blueprint with execution history | **Shipped** as an additive tab: Scheduled/Queued/Running/Waiting for input, blueprint subgroups, History filters, Task detail with progress, Inbox item, transcript and outcome. Sessions stays for legacy work. | [`src/web/app.js`](../../src/web/app.js#L1315), [`src/web/index.html`](../../src/web/index.html) |
| Task outcome reaches the conversation without model polling | **Shipped** as durable notices in chat plus one-shot exposure in the next orchestrator turn. No proactive model turn is started, so a conversation with no later turn sees the notice only in the UI. | [`notices`](../../src/task-store.mjs#L434), [`runWebTurn`](../../src/relay.mjs#L1024), [`refreshTaskNotices`](../../src/web/app.js#L1632) |

`npm test` passes on this checkout, including the fixture relay/worker flow, the ledger unit test, and the Chromium
Tasks view test.
