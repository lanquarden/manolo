# Manolo

Language for task orchestration. See [Task orchestration](docs/tasks/README.md) for what ships in this checkout and what is still design.

## Language

**Conversation**:
The user-facing exchange with Manolo in web chat or a messaging thread.

**Orchestrator**:
Manolo's role in a conversation: coordinates delegated work and communicates with the user about it.

**Task**:
One durable assignment that keeps its identity through queuing, execution, and pauses for user input.
_Avoid_: Session, when referring to an assignment rather than its execution history.

**Blueprint**:
A reusable recipe for a kind of work: explicit Markdown text, exact tools, an optional named model profile, and an optional repository binding. A task uses a particular pinned revision.
_Avoid_: Prompt, when referring to the versioned recipe rather than its text.

**Profile**:
A named provider, model, and reasoning selection that a Blueprint or Task pins. A profile the worker cannot resolve is unavailable; it is never substituted.

**Task workspace**:
The directory a Task's file and shell tools use. A repository Task gets its own Git worktree on `task/<task id>`; any other Task gets its own scratch directory. It is not a security boundary.

**Handoff**:
The configured remote and scoped Task branch where a repository Task's final commit is verified before `finish`. The verification is read-only, and the evidence (commit, base, branch, remote) stays visible on the Task.

**Review Task**:
A Task bound to a finished source Task's exact handed-off commit and comparison base, with its own worktree. It never follows a mutable branch tip.

**Blocked Task**:
A running Task whose worker, profile, tool, or workspace is temporarily unavailable. It keeps the same execution identity and a visible reason; restoring the condition resumes it instead of substituting another selection.

**Trigger**:
A rule that creates a new task for each matching time or event occurrence.

**Inbox item**:
A question or report awaiting the user's response. A question requests an answer; a report requests a review. A progress update does neither.

**Finish**:
The child's explicit declaration that the Task's work is complete and verified. Acceptance is a one-way durable boundary: later work, progress, Inbox items, or a failure report cannot undo it. A bare final turn triggers at most one corrective turn, then fails.
