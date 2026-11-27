export const title = 'Manolo: Inbox and conversation notification';
export const state = ({ origin, kind, item, notice }) => ({
  'Web Inbox': item === 'answered' ? 'Response saved' : item === 'open' ? 'Question or report open'
    : kind === 'progress' ? 'Progress does not need a response' : 'No item',
  Conversation: notice === 'pending' ? 'Notification pending'
    : notice === 'none' ? 'No notification' : origin === 'web' ? 'Update visible in web chat' : 'Update relayed in originating thread',
});
export const step = (action, _from, to) => ({
  Publish: to.kind === 'progress' ? 'Task posts progress' : 'Task asks for input',
  SurfaceInOrigin: 'Orchestrator surfaces update', Respond: 'User responds in web Inbox',
})[action] ?? null;
