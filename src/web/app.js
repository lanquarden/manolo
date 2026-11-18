const byId = (id) => document.getElementById(id);
const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 1_500;
const POLL_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, method = 'GET', body, timeout = REQUEST_TIMEOUT_MS) {
  const options = {
    method,
    mode: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', 'X-Manolo-Request': '1' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    throw Object.assign(new Error(`Request failed (${response.status}).`), { status: response.status });
  }
  return response.json();
}

function failure(error) {
  if (error.status === 401) return 'Sign in as an owner and try again.';
  if (error.name === 'TimeoutError') return 'The request timed out.';
  return error.status ? error.message : 'Could not complete the request.';
}

const dashboardControls = byId('dashboard-controls');
const dashboardStatus = byId('dashboard-status');
const publishButton = byId('publish-dashboard');
const draftInput = byId('draft-spec');
let dashboard;
let draftEdited = false;

function renderVersion(target, version, emptyText) {
  target.replaceChildren();
  if (!version) {
    target.append(textNode('p', emptyText));
    return;
  }
  target.append(
    textNode('p', `Revision ${version.revision}`),
    textNode('h4', version.spec.title, 'plain-text'),
  );
  for (const widget of version.spec.widgets) {
    if (widget.kind === 'heading') target.append(textNode('h5', widget.text, 'plain-text'));
    if (widget.kind === 'note') target.append(textNode('p', widget.text, 'plain-text'));
  }
}

function renderDashboard() {
  renderVersion(byId('published-dashboard'), dashboard.current, 'Nothing published yet.');
  renderVersion(byId('draft-dashboard'), dashboard.draft, 'No saved draft.');
  publishButton.disabled = !dashboard.draft;

  const history = byId('dashboard-history');
  history.replaceChildren();
  if (dashboard.history.length === 0) history.append(textNode('li', 'No past publications yet.'));
  for (const version of dashboard.history) {
    const row = textNode('li', `Revision ${version.revision}: ${version.spec.title}`);
    const restore = textNode('button', `Restore revision ${version.revision}`);
    restore.type = 'button';
    restore.addEventListener('click', () => updateDashboard(
      '/api/dashboard/rollback', 'POST', { revision: version.revision }, 'Revision restored.',
    ));
    row.append(restore);
    history.append(row);
  }
  if (dashboard.draft && !draftEdited) draftInput.value = JSON.stringify(dashboard.draft.spec, null, 2);
}

async function updateDashboard(path, method, body, success) {
  if (dashboardControls.disabled) return;
  dashboardControls.disabled = true;
  dashboardStatus.textContent = 'Working…';
  try {
    dashboard = await api(path, method, body);
    renderDashboard();
    dashboardStatus.textContent = success;
    if (path.endsWith('/draft')) draftEdited = false;
  } catch (error) {
    const messages = {
      400: 'Draft rejected. Use the required fields and bounded plain text.',
      409: 'The dashboard changed or is busy. Refresh before retrying.',
      413: 'Draft is too large. Shorten the specification and try again.',
    };
    dashboardStatus.textContent = messages[error.status] ?? failure(error);
  } finally {
    dashboardControls.disabled = false;
  }
}

function refreshDashboard() {
  return updateDashboard('/api/dashboard', 'GET', undefined, '');
}

byId('refresh-dashboard').addEventListener('click', refreshDashboard);
publishButton.addEventListener('click', () => {
  if (dashboard?.draft) {
    void updateDashboard('/api/dashboard/publish', 'POST', { revision: dashboard.draft.revision }, 'Draft published.');
  }
});
draftInput.addEventListener('input', () => { draftEdited = true; });
byId('draft-form').addEventListener('submit', (event) => {
  event.preventDefault();
  let spec;
  try {
    spec = JSON.parse(draftInput.value);
  } catch {
    dashboardStatus.textContent = 'Enter valid JSON before saving the draft.';
    return;
  }
  void updateDashboard('/api/dashboard/draft', 'PUT', spec, 'Draft saved. Review the preview before publishing.');
});

const refreshInboxButton = byId('refresh-inbox');
const inboxStatus = byId('inbox-status');

async function refreshInbox() {
  refreshInboxButton.disabled = true;
  inboxStatus.textContent = 'Loading inbox…';
  try {
    const { messages } = await api('/api/inbox');
    const entries = messages.map(({ from, text, createdAt }) => {
      const item = document.createElement('li');
      item.append(textNode('strong', from), textNode('div', createdAt), textNode('div', text, 'plain-text'));
      return item;
    });
    byId('inbox').replaceChildren(...entries);
    inboxStatus.textContent = entries.length ? '' : 'No messages yet.';
  } catch (error) {
    inboxStatus.textContent = failure(error);
  } finally {
    refreshInboxButton.disabled = false;
  }
}

refreshInboxButton.addEventListener('click', refreshInbox);

const chatInput = byId('chat-text');
const chatStatus = byId('chat-status');
const chatLog = byId('chat-log');
const sendButton = byId('send-chat');
const checkButton = byId('check-turn');
const refreshHistoryButton = byId('refresh-chat');
const HISTORY_LIMIT = 30;
let turns = new Map();
let unconfirmedTurn;
let historyLoaded = false;
let chatBusy = false;

function pendingTurn() {
  return [...turns.values()].findLast((turn) => turn.status === 'pending');
}

function setChatBusy(busy) {
  chatBusy = busy;
  const pending = pendingTurn();
  // Serialize history loads, submits and checks; a snapshot can't overwrite a newer reply.
  refreshHistoryButton.disabled = busy;
  sendButton.disabled = busy || !historyLoaded || Boolean(pending);
  checkButton.disabled = busy;
  checkButton.hidden = !pending;
}

function idleChatStatus() {
  if (pendingTurn()) return 'A reply is pending. Use “Check reply” before sending another message.';
  return turns.size ? '' : 'No saved messages yet.';
}

function renderHistory() {
  const rows = [...turns.values()].slice(-HISTORY_LIMIT).map(({ text, status, reply }) => {
    const row = document.createElement('li');
    row.append(textNode('strong', 'You'), textNode('div', text, 'plain-text'));
    const answer = document.createElement('div');
    answer.className = 'chat-answer';
    answer.append(textNode('strong', 'Manolo'));
    if (status === 'done') {
      answer.append(textNode('div', reply ?? '(No reply text.)', 'plain-text'));
    } else {
      const message = status === 'failed' ? 'Turn failed.' : 'Reply pending.';
      answer.append(textNode('div', message, 'chat-turn-state'));
      if (status === 'failed' && reply) answer.append(textNode('div', reply, 'plain-text'));
    }
    row.append(answer);
    return row;
  });
  chatLog.replaceChildren(...rows);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function refreshHistory() {
  if (chatBusy) return;
  setChatBusy(true);
  chatStatus.textContent = 'Loading chat history…';
  try {
    const history = await api('/api/turns');
    const saved = new Map(history.turns.map((turn) => [turn.id, turn]));
    const notSaved = unconfirmedTurn && !saved.has(unconfirmedTurn.id);
    if (notSaved && !chatInput.value) chatInput.value = unconfirmedTurn.text;
    unconfirmedTurn = undefined;
    turns = saved;
    historyLoaded = true;
    renderHistory();
    chatStatus.textContent = notSaved
      ? 'The last submission was not found in history. Review before retrying. ' + idleChatStatus()
      : idleChatStatus();
  } catch (error) {
    chatStatus.textContent = `${failure(error)} Use “Refresh history” to try again.`;
  } finally {
    setChatBusy(false);
  }
}

function recordTurnStatus(turn, result) {
  if (!['done', 'failed', 'pending'].includes(result?.status)) throw new Error('Unexpected turn status');
  if (unconfirmedTurn?.id === turn.id) unconfirmedTurn = undefined;
  if (result.status === 'pending') return;
  turns.set(turn.id, { ...turn, status: result.status, reply: typeof result.text === 'string' ? result.text : undefined });
  while (turns.size > HISTORY_LIMIT) turns.delete(turns.keys().next().value);
  renderHistory();
}

async function runTurn(turn, submit) {
  setChatBusy(true);
  chatStatus.textContent = 'Waiting for Manolo…';
  const { id, text } = turn;
  const path = `/api/turns/${encodeURIComponent(id)}`;
  try {
    let result = submit ? await api('/api/turns', 'POST', { id, text }) : await api(path);
    recordTurnStatus(turn, result);
    const deadline = performance.now() + POLL_WINDOW_MS;
    for (let count = 0; result.status === 'pending' && count < MAX_POLLS; count++) {
      if (deadline - performance.now() <= POLL_INTERVAL_MS) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) break;
      result = await api(path, 'GET', undefined, Math.min(REQUEST_TIMEOUT_MS, remaining));
      recordTurnStatus(turn, result);
    }
    chatStatus.textContent = idleChatStatus();
  } catch (error) {
    const rejected = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    if (submit && unconfirmedTurn?.id === id && rejected) {
      unconfirmedTurn = undefined;
      turns.delete(id);
      if (!chatInput.value) chatInput.value = text;
      renderHistory();
    }
    chatStatus.textContent = failure(error) + (pendingTurn() ? ' Use “Check reply” or “Refresh history”.' : '');
  } finally {
    setChatBusy(false);
  }
}

byId('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (chatBusy || !historyLoaded || pendingTurn() || !text) return;
  if (typeof crypto.randomUUID !== 'function') {
    chatStatus.textContent = 'Chat requires HTTPS or localhost.';
    return;
  }
  const turn = { id: crypto.randomUUID(), text, status: 'pending' };
  turns.set(turn.id, turn);
  unconfirmedTurn = turn;
  chatInput.value = '';
  renderHistory();
  void runTurn(turn, true);
});
checkButton.addEventListener('click', () => {
  const turn = pendingTurn();
  if (!chatBusy && turn) void runTurn(turn, false);
});
refreshHistoryButton.addEventListener('click', refreshHistory);

void refreshDashboard();
void refreshInbox();
void refreshHistory();
