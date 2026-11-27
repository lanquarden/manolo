export const title = 'Manolo: One trigger occurrence';
// The view encodes tuple keys as JSON objects indexed from 1.
const count = (created, source) => created[JSON.stringify({ 1: source, 2: 1 })];
export const state = ({ tick, matching, created }) => ({
  Schedule: count(created, 'scheduled') > 0
    ? 'Scheduled task created' : tick > 0 ? 'Occurrence due' : 'Waiting for scheduled time',
  Message: count(created, 'message') > 0
    ? 'Message task created' : matching.includes(1) ? 'Matching message received' : 'Waiting for matching message',
});
export const step = action => ({
  ClockTicks: 'Scheduled time arrives', MessageArrives: 'New matching inbound message',
  AdmitOccurrence: 'Create one queued task',
})[action] ?? null;
