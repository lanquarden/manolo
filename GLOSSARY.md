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
A reusable recipe for a kind of work. A task uses a particular blueprint revision.

**Trigger**:
A rule that creates a new task for each matching time or event occurrence.

**Inbox item**:
A question or report awaiting the user's response. A question requests an answer; a report requests a review. A progress update does neither.
