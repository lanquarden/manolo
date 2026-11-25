const byId = (id) => document.getElementById(id);
const POLL_INTERVAL_MS = 800;
const POLL_WINDOW_MS = 10 * 60_000;
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

const tabList = byId('workspace-tabs');
const tabs = [...tabList.querySelectorAll('[role="tab"]')];
const visibleTabs = () => tabs.filter(tab => !tab.hidden);
const compactNav = matchMedia('(max-width: 48.999rem)');
function orientTabs() {
  tabList.setAttribute('aria-orientation', compactNav.matches ? 'horizontal' : 'vertical');
}
function showTab(selected) {
  for (const tab of tabs) {
    const active = selected === tab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    byId(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (selected.id === 'chat-tab') scrollChatToEnd();
  if (selected.id === 'browser-tab') openDesktop();
}
for (const tab of tabs) tab.addEventListener('click', () => showTab(tab));
tabList.addEventListener('keydown', (event) => {
  const list = visibleTabs();
  const index = list.indexOf(event.target);
  if (index < 0) return;
  const previous = compactNav.matches ? 'ArrowLeft' : 'ArrowUp';
  const next = compactNav.matches ? 'ArrowRight' : 'ArrowDown';
  let destination;
  if (event.key === previous) destination = (index + list.length - 1) % list.length;
  else if (event.key === next) destination = (index + 1) % list.length;
  else if (event.key === 'Home') destination = 0;
  else if (event.key === 'End') destination = list.length - 1;
  else return;
  event.preventDefault();
  showTab(list[destination]);
  list[destination].focus();
});
compactNav.addEventListener('change', orientTabs);
orientTabs();

// The desktop is another same-origin document that the relay proxies to this owner's worker browser. It is only
// loaded once the session says this agent has one, and only when the tab is first opened.
const browserTab = byId('browser-tab');
const browserFrame = byId('browser-frame');
const browserStatus = byId('browser-status');
const reloadBrowserButton = byId('reload-browser');
let browserAvailable = false;
function openDesktop() {
  browserFrame.hidden = false;
  if (!browserFrame.getAttribute('src')) browserFrame.src = '/desktop/';
}
async function refreshBrowser() {
  let available = false;
  try {
    available = Boolean((await api('/api/session')).browser);
  } catch {
    available = false;
  }
  browserAvailable = available;
  browserTab.hidden = !available;
  if (!available) return;
  if (browserStatus.textContent === 'The desktop is loading.') {
    browserStatus.textContent = 'The agent and you share this window; activity appears on both.';
  }
}
reloadBrowserButton.addEventListener('click', () => {
  if (!browserAvailable) return;
  browserFrame.src = '/desktop/';
});
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
    textNode('p', `Revision ${version.revision}`, 'revision-tag'),
    textNode('h3', version.spec.title, 'plain-text'),
  );
  for (const widget of version.spec.widgets) {
    if (widget.kind === 'heading') target.append(textNode('h4', widget.text, 'plain-text'));
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
      const date = new Date(createdAt);
      const time = textNode('time', Number.isNaN(date.getTime()) ? '' : date.toLocaleString());
      if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
      item.append(textNode('strong', from), time, textNode('div', text, 'plain-text'));
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

const runtimeSection = byId('paired-runtimes');
const runtimeControls = byId('runtime-controls');
const runtimeList = byId('runtime-list');
const runtimeStatus = byId('runtime-status');
const runtimePairing = byId('runtime-pairing');
const runtimeCode = byId('runtime-code');
const runtimeCodeExpiry = byId('runtime-code-expiry');
const runtimesPath = '/api/runtimes';
let runtimeCodeTimer;

function clearRuntimeCode() {
  clearTimeout(runtimeCodeTimer);
  runtimePairing.hidden = true;
  runtimeCode.textContent = '';
  runtimeCodeExpiry.textContent = '';
  runtimeCodeExpiry.removeAttribute('datetime');
}

async function runtimeAction(progress, action, hideOnNotFound = false) {
  if (runtimeControls.disabled) return;
  runtimeControls.disabled = true;
  runtimeStatus.textContent = progress;
  try {
    await action();
  } catch (error) {
    if (error.status === 401 || (hideOnNotFound && error.status === 404)) {
      runtimeSection.hidden = true;
      runtimeList.replaceChildren();
      clearRuntimeCode();
    }
    runtimeStatus.textContent = failure(error);
  } finally {
    runtimeControls.disabled = false;
  }
}

async function loadRuntimes(message = '') {
  const { runtimes } = await api(runtimesPath);
  const rows = runtimes.map(({ id, name, online }) => {
    const row = document.createElement('li');
    const revoke = textNode('button', 'Revoke');
    revoke.type = 'button';
    revoke.setAttribute('aria-label', `Revoke ${name}`);
    revoke.addEventListener('click', () => {
      if (!window.confirm(`Revoke access for “${name}”?`)) return;
      void runtimeAction('Revoking runtime…', async () => {
        try {
          const { ok } = await api(`${runtimesPath}/${encodeURIComponent(id)}/revoke`, 'POST', {});
          if (ok !== true) throw new Error('Unexpected revoke response');
          row.remove();
        } catch (error) {
          // A stale row may already have been revoked in another tab.
          if (error.status !== 404) throw error;
          await loadRuntimes('Runtime is no longer paired.');
          return;
        }
        runtimeStatus.textContent = runtimeList.children.length ? 'Runtime revoked.' : 'Runtime revoked. No paired runtimes.';
      }, true);
    });
    row.append(textNode('span', `${name} — ${online ? 'Online' : 'Offline'}`), revoke);
    return row;
  });
  runtimeList.replaceChildren(...rows);
  runtimeStatus.textContent = message || (rows.length ? '' : 'No paired runtimes.');
  runtimeSection.hidden = false;
}

function refreshRuntimes() {
  return runtimeAction('Refreshing runtimes…', loadRuntimes, true);
}

byId('refresh-runtimes').addEventListener('click', refreshRuntimes);
byId('generate-pairing-code').addEventListener('click', () => {
  void runtimeAction('Generating pairing code…', async () => {
    clearRuntimeCode();
    const { code, expires } = await api(`${runtimesPath}/enroll`, 'POST', {});
    const expiry = new Date(expires);
    const remaining = expires - Date.now();
    if (typeof code !== 'string' || !code || !Number.isFinite(expires) || !Number.isFinite(expiry.getTime())) {
      throw new Error('Unexpected pairing code response');
    }
    if (remaining <= 0) {
      runtimeStatus.textContent = 'Pairing code expired. Generate a new code.';
      return;
    }
    runtimeCode.textContent = code;
    runtimeCodeExpiry.textContent = expiry.toLocaleTimeString();
    runtimeCodeExpiry.dateTime = expiry.toISOString();
    runtimePairing.hidden = false;
    const generatedMessage = 'Pairing code generated. Keep it private.';
    runtimeStatus.textContent = generatedMessage;
    runtimeCodeTimer = setTimeout(() => {
      clearRuntimeCode();
      if (runtimeStatus.textContent === generatedMessage) runtimeStatus.textContent = 'Pairing code expired.';
    }, remaining);
  }, true);
});

const chatInput = byId('chat-text');
const chatStatus = byId('chat-status');
const chatLog = byId('chat-log');
const chatEmpty = byId('chat-empty');
const transcript = byId('chat-transcript');
const chatPanel = byId('chat-panel');
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
  return '';
}

function scrollChatToEnd() {
  if (!chatPanel.hidden) transcript.scrollTop = transcript.scrollHeight;
}

const TOOL_STATUS = { ok: 'ok', error: 'failed', pending: 'queued', running: 'running', done: 'ok' };

function renderThinking(thinking) {
  const details = document.createElement('details');
  details.className = 'chat-thinking';
  details.append(textNode('summary', 'Thinking'));
  details.append(textNode('div', thinking, 'chat-thinking-text'));
  return details;
}

function renderToolImage(turnId, image) {
  const frame = document.createElement('figure');
  frame.className = 'tool-image';
  const img = document.createElement('img');
  img.src = `/api/turn-image/${encodeURIComponent(turnId)}/${image.index}`;
  img.alt = 'Image returned by a tool';
  img.loading = 'lazy';
  frame.append(img);
  return frame;
}

function renderTools(tools, turnId) {
  const list = document.createElement('ul');
  list.className = 'chat-tools';
  for (const tool of tools) {
    const item = document.createElement('li');
    const details = document.createElement('details');
    details.className = 'chat-tool';
    details.dataset.status = tool.status;
    // An image the agent read is the point of the call, so show it without another click.
    if (tool.images?.length) details.open = true;
    const summary = document.createElement('summary');
    summary.append(
      textNode('span', tool.name, 'tool-name'),
      textNode('span', TOOL_STATUS[tool.status] ?? tool.status, 'tool-status'),
    );
    const preview = (tool.args ?? '').replace(/\s+/g, ' ').trim();
    if (preview) summary.append(textNode('span', preview.slice(0, 90), 'tool-preview'));
    details.append(summary);
    for (const image of tool.images ?? []) details.append(renderToolImage(turnId, image));
    if (tool.args) details.append(textNode('pre', tool.args, 'tool-args'));
    if (tool.diff) details.append(textNode('pre', tool.diff, 'tool-diff'));
    if (tool.output) details.append(textNode('pre', tool.output, 'tool-output'));
    if (tool.droppedLines) details.append(textNode('p', `${tool.droppedLines} earlier lines dropped.`, 'tool-dropped'));
    if (tool.diagnostics?.length) {
      const notes = document.createElement('ul');
      notes.className = 'tool-diagnostics';
      for (const note of tool.diagnostics) {
        notes.append(textNode('li', note.message, `tool-diagnostic ${note.severity}`));
      }
      details.append(notes);
    }
    item.append(details);
    list.append(item);
  }
  return list;
}

function renderHistory() {
  const rows = [...turns.values()].slice(-HISTORY_LIMIT).map(({ id, text, status, reply, tools, live }) => {
    const row = document.createElement('li');
    row.className = 'chat-turn';
    row.append(textNode('strong', 'You', 'chat-user'), textNode('div', text, 'chat-prompt plain-text'));
    const answer = document.createElement('div');
    answer.className = 'chat-answer';
    answer.dataset.state = status;
    answer.append(textNode('strong', 'Manolo'));
    if (status === 'done') {
      if (Array.isArray(tools) && tools.length > 0) answer.append(renderTools(tools, id));
      answer.append(textNode('div', reply ?? '(No reply text.)', 'plain-text'));
    } else {
      const message = status === 'failed' ? 'Turn failed.' : 'Reply pending.';
      answer.append(textNode('div', message, 'chat-turn-state'));
      if (status === 'failed' && reply) answer.append(textNode('div', reply, 'plain-text'));
      if (status === 'pending' && live) {
        if (live.thinking) answer.append(renderThinking(live.thinking));
        if (live.tools?.length) answer.append(renderTools(live.tools, id));
        if (live.text) answer.append(textNode('div', live.text, 'chat-stream plain-text'));
        if (live.retry) answer.append(textNode('div', 'Retrying the model request…', 'chat-turn-state'));
      }
    }
    row.append(answer);
    return row;
  });
  chatLog.replaceChildren(...rows);
  chatEmpty.hidden = !historyLoaded || rows.length > 0;
  scrollChatToEnd();
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
  if (result.status === 'pending') {
    if (result.live) {
      turns.set(turn.id, { ...turn, status: 'pending', live: result.live });
      renderHistory();
    }
    return;
  }
  turns.set(turn.id, {
    ...turn, status: result.status, live: undefined,
    reply: typeof result.text === 'string' ? result.text : undefined,
    tools: Array.isArray(result.tools) ? result.tools : undefined,
  });
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
    // Stream while the turn runs: poll the relay faster than history refreshes, but never more than the window.
    const deadline = performance.now() + POLL_WINDOW_MS;
    while (result.status === 'pending') {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) break;
      result = await api(path, 'GET', undefined, Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, left)));
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

const chatForm = byId('chat-form');
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    if (!sendButton.disabled) chatForm.requestSubmit(sendButton);
  }
});
chatForm.addEventListener('submit', (event) => {
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

const mcpList = byId('mcp-list');
const mcpStatus = byId('mcp-status');
const mcpConfig = byId('mcp-config');
const mcpForm = byId('mcp-form');
const refreshMcpButton = byId('refresh-mcp');

function renderMcp(state) {
  const rows = (state.servers ?? []).map(server => {
    const item = document.createElement('li');
    const title = textNode('span', `${server.name} · ${server.tools} tool${server.tools === 1 ? '' : 's'}`);
    const state_ = textNode('span', server.state, 'badge');
    const actions = document.createElement('span');
    actions.className = 'mcp-actions';
    if (server.authUrl) {
      const signIn = textNode('button', 'Sign in');
      signIn.type = 'button';
      signIn.addEventListener('click', () => {
        window.open(server.authUrl, '_blank', 'noopener');
        mcpStatus.textContent = `Authorize ${server.name} in the new tab; this list refreshes afterwards.`;
      });
      actions.append(signIn);
    }
    item.append(title, state_, actions);
    if (server.error) item.append(textNode('p', server.error, 'plain-text'));
    return item;
  });
  mcpList.replaceChildren(...rows);
  if (!rows.length) mcpList.append(textNode('li', 'No MCP servers configured.'));
  if (state.error) mcpStatus.textContent = state.error;
  // Do not fight the owner's edits: only replace the editor when it is not focused.
  if (document.activeElement !== mcpConfig && typeof state.config === 'string') mcpConfig.value = state.config;
}

async function refreshMcp() {
  refreshMcpButton.disabled = true;
  try {
    const state = await api('/api/mcp');
    renderMcp(state);
    if (!state.error) mcpStatus.textContent = '';
  } catch (error) {
    mcpStatus.textContent = failure(error);
  } finally {
    refreshMcpButton.disabled = false;
  }
}

refreshMcpButton.addEventListener('click', () => void refreshMcp());
mcpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mcpStatus.textContent = 'Saving…';
  try {
    const state = await api('/api/mcp/config', 'PUT', { text: mcpConfig.value });
    renderMcp(state);
    mcpStatus.textContent = state.error ?? 'Applied.';
  } catch (error) {
    mcpStatus.textContent = failure(error);
  }
});

void refreshDashboard();
void refreshInbox();
void refreshHistory();
void refreshRuntimes();
void refreshBrowser();
void refreshMcp();
