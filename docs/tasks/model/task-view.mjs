export const title = 'Manolo: Task lifecycle';
export const state = ({ phase, due }) => ({
  absent: 'No task', queued: due ? 'Queued' : 'Queued for later', running: 'Running',
  waiting: 'Waiting for a web Inbox response', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
})[phase];
export const step = (action, from, to) => ({
  CreateTask: to.due ? 'Create for immediate eligibility' : 'Create for a future time',
  TimeArrives: 'Scheduled time arrives', Claim: 'Scheduler claims the task [when eligible]',
  AskForInput: 'Task asks a question or requests report review', Respond: 'User responds in web Inbox',
  Finish: to.phase === 'completed' ? 'Task finishes' : 'Task fails', Cancel: 'User cancels',
})[action] ?? null;
export const group = ({ phase }) => ({ absent: 'No task / cancelled', queued: 'Queued', running: 'Running / completed', waiting: 'Needs input', completed: 'Running / completed', failed: 'Failed', cancelled: 'No task / cancelled' })[phase];
export const colors = { 'No task / cancelled': 'tan', 'Queued': 'blue', 'Running / completed': 'teal', 'Needs input': 'yellow', 'Failed': 'orange' };
