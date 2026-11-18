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
let activeTurn;
let chatBusy = false;

function appendChat(sender, text) {
  const row = document.createElement('li');
  row.append(textNode('strong', sender), textNode('div', text, 'plain-text'));
  chatLog.append(row);
  if (chatLog.childElementCount > 50) chatLog.firstElementChild.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function runTurn(submit) {
  if (chatBusy || !activeTurn) return;
  chatBusy = true;
  sendButton.disabled = checkButton.disabled = chatInput.disabled = true;
  chatStatus.textContent = 'Waiting for Manolo…';
  const turn = activeTurn;
  const path = `/api/turns/${encodeURIComponent(turn.id)}`;
  try {
    let reply = submit ? await api('/api/turns', 'POST', turn) : await api(path);
    const deadline = performance.now() + POLL_WINDOW_MS;
    for (let count = 0; reply?.status === 'pending' && count < MAX_POLLS; count++) {
      if (deadline - performance.now() <= POLL_INTERVAL_MS) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) break;
      reply = await api(path, 'GET', undefined, Math.min(REQUEST_TIMEOUT_MS, remaining));
    }
    if (reply?.status === 'done') {
      appendChat('Manolo', typeof reply.text === 'string' ? reply.text : '(No reply text.)');
      activeTurn = null;
      chatStatus.textContent = '';
    } else if (reply?.status === 'failed') {
      activeTurn = null;
      chatStatus.textContent = typeof reply.text === 'string' && reply.text ? reply.text : 'Turn failed.';
    } else if (reply?.status === 'pending') {
      chatStatus.textContent = 'Still waiting. Use “Check reply” to check the same turn.';
    } else {
      throw new Error('Unexpected turn status');
    }
  } catch (error) {
    const rejected = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
    if (rejected) {
      activeTurn = null;
      if (!chatInput.value) chatInput.value = turn.text;
    }
    chatStatus.textContent = failure(error) + (activeTurn ? ' Use “Check reply” to check the same turn.' : '');
  } finally {
    chatBusy = false;
    sendButton.disabled = checkButton.disabled = chatInput.disabled = false;
    checkButton.hidden = !activeTurn;
  }
}

byId('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (chatBusy || !text) return;
  if (typeof crypto.randomUUID !== 'function') {
    chatStatus.textContent = 'Chat requires HTTPS or localhost.';
    return;
  }
  activeTurn = { id: crypto.randomUUID(), text };
  appendChat('You', text);
  chatInput.value = '';
  void runTurn(true);
});
checkButton.addEventListener('click', () => { void runTurn(false); });

void refreshDashboard();
void refreshInbox();
