export const title = 'Manolo: Dependent task eligibility';
const allows = ({ phase, dep }) => phase === 'completed' || (dep === 'terminal' && ['failed', 'cancelled'].includes(phase));
export const state = v => v.follower === 'started' ? 'Task B starts'
  : allows(v) ? 'Outcome gate cleared'
  : ['failed', 'cancelled'].includes(v.phase) ? 'Blocked: Task A did not succeed'
  : 'Waiting for Task A';
export const step = (action, _from, to) => {
  if (action === 'StartFollower') return 'Scheduler claims Task B [if otherwise eligible]';
  if (action === 'Finish' || action === 'Cancel') {
    if (to.phase === 'completed') return 'Task A succeeds';
    return allows(to) ? 'Task A fails or is cancelled [any outcome allowed]' : 'Task A fails or is cancelled [success required]';
  }
  return null;
};
