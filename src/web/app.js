const byId = (id) => document.getElementById(id);
const POLL_INTERVAL_MS = 800;
const POLL_WINDOW_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_PATH = '/api/session';
const LOGOUT_PATH = '/logout';
const LOGIN_PATH = '/login';

let leavingWorkspace = false;
function redirectToLogin() {
  // One navigation only: parallel requests can each come back 401.
  if (leavingWorkspace) return;
  leavingWorkspace = true;
  location.replace(LOGIN_PATH);
}

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
    // A browser session that ended means the sign-in page, not an inline error. The initial
    // session probe handles its own 401 so the workspace never navigates twice.
    if (response.status === 401 && path !== SESSION_PATH) redirectToLogin();
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
// The browser tab only exists for an agent with a desktop, so keyboard navigation skips hidden tabs.
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
  if (selected.id === 'sessions-tab') void refreshSessions();
  if (selected.id === 'inbox-tab') void refreshInbox();
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
const inboxPanel = byId('inbox-panel');
const questionsSection = byId('inbox-questions-section');
const questionsList = byId('inbox-questions');
const WORKER_INPUT_LIMIT = 4000;
const questionViews = new Map();
let inboxBusy = false;
let verifyInboxBeforeResponding = false;

function setInboxBusy(busy) {
  inboxBusy = busy;
  refreshInboxButton.disabled = busy;
  for (const { controls } of questionViews.values()) {
    if (controls) controls.disabled = busy || verifyInboxBeforeResponding;
  }
}

function validInboxId(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..';
}

function inboxQuestion({ id, parentTurnId, prompt, status, continuationTurnId }) {
  if (!validInboxId(id) || !validInboxId(parentTurnId) || typeof prompt !== 'string'
    || !['open', 'answered', 'declined'].includes(status)
    || (continuationTurnId !== undefined && !validInboxId(continuationTurnId))) {
    throw new Error('Unexpected inbox question');
  }
  return { id, parentTurnId, prompt, status, continuationTurnId };
}

function answerBudget({ id, parentTurnId, prompt }) {
  // Match the relay's continuation framing: the worker counts UTF-16 units after JSON quoting.
  const context = `Previous assistant context (original web turn ${parentTurnId}; inbox question ${id}):\n${JSON.stringify(prompt)}\n\nOwner input (answer):\n`;
  return WORKER_INPUT_LIMIT - context.length;
}

function createQuestionView(question, draft = '') {
  const { prompt, status, continuationTurnId } = question;
  const row = document.createElement('li');
  row.className = 'inbox-question';
  row.tabIndex = -1;
  row.append(textNode('p', prompt, 'plain-text'), textNode('p', {
    open: 'Awaiting a response', answered: 'Answered', declined: 'Declined',
  }[status], 'question-state'));
  const view = { question, row };

  if (status === 'open') {
    const form = document.createElement('form');
    const controls = document.createElement('fieldset');
    const label = textNode('label', 'Your answer');
    const answer = document.createElement('textarea');
    const budget = answerBudget(question);
    answer.rows = 2;
    answer.maxLength = Math.max(0, budget - 2); // The surrounding JSON quotes need two units.
    answer.required = true;
    answer.value = draft;
    label.append(answer);
    const actions = document.createElement('div');
    actions.className = 'question-actions';
    const send = textNode('button', 'Send answer', 'primary-button');
    send.type = 'submit';
    const decline = textNode('button', 'Decline');
    decline.type = 'button';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = answer.value.trim();
      if (!text) {
        inboxStatus.textContent = 'Enter an answer before sending.';
        return;
      }
      if (JSON.stringify(text).length > budget) {
        inboxStatus.textContent = 'This answer is too long for the continuation. Shorten it and try again.';
        return;
      }
      void respondToQuestion(view, { answer: text });
    });
    decline.addEventListener('click', () => void respondToQuestion(view, { decline: true }));
    actions.append(send, decline);
    controls.append(label, actions);
    form.append(controls);
    row.append(form);
    Object.assign(view, { controls, answer });
  } else if (continuationTurnId) {
    const button = textNode('button', 'Refresh and view in Chat');
    button.type = 'button';
    const notice = textNode('p', '', 'question-state');
    notice.setAttribute('role', 'status');
    button.addEventListener('click', () => void viewContinuation(continuationTurnId, button, notice));
    row.append(button, notice);
    view.continuationButton = button;
  }
  return view;
}

function renderInboxQuestions(questions) {
  questionsSection.hidden = questions === undefined;
  const visibleIds = new Set((questions ?? []).map(({ id }) => id));
  for (const [id, { row }] of questionViews) {
    if (visibleIds.has(id)) continue;
    row.remove();
    questionViews.delete(id);
  }
  for (const [index, question] of (questions ?? []).entries()) {
    const previous = questionViews.get(question.id);
    let view = previous;
    if (!previous || JSON.stringify(previous.question) !== JSON.stringify(question)) {
      view = createQuestionView(question, previous?.answer?.value);
      previous?.row.remove();
      questionViews.set(question.id, view);
    }
    const atIndex = questionsList.children[index];
    if (view.row !== atIndex) questionsList.insertBefore(view.row, atIndex ?? null);
  }
  byId('inbox-questions-empty').hidden = Boolean(questions?.length);
}

async function refreshInbox() {
  if (inboxBusy) return;
  setInboxBusy(true);
  inboxStatus.textContent = 'Loading inbox…';
  try {
    const { messages, questions } = await api('/api/inbox');
    const nextQuestions = questions?.map(inboxQuestion);
    const entries = messages.map(({ from, text, createdAt }) => {
      const item = document.createElement('li');
      const date = new Date(createdAt);
      const time = textNode('time', Number.isNaN(date.getTime()) ? '' : date.toLocaleString());
      if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
      item.append(textNode('strong', from), time, textNode('div', text, 'plain-text'));
      return item;
    });
    byId('inbox').replaceChildren(...entries);
    byId('inbox-messages-empty').hidden = Boolean(entries.length);
    renderInboxQuestions(nextQuestions);
    inboxStatus.textContent = verifyInboxBeforeResponding ? 'Inbox refreshed. Check the question’s current status before retrying.' : '';
    verifyInboxBeforeResponding = false;
  } catch (error) {
    inboxStatus.textContent = `${failure(error)} Use “Refresh inbox” to try again.`;
  } finally {
    setInboxBusy(false);
  }
}

async function respondToQuestion(view, body) {
  if (inboxBusy || verifyInboxBeforeResponding) return;
  const { question, row } = view;
  const restoreFocus = row.contains(document.activeElement);
  setInboxBusy(true);
  inboxStatus.textContent = body.decline ? 'Declining question…' : 'Sending answer…';
  try {
    const { id, status, continuationTurnId } = await api(`/api/inbox/questions/${encodeURIComponent(question.id)}/respond`, 'POST', body);
    if (id !== question.id || status !== (body.decline ? 'declined' : 'answered')) throw new Error('Unexpected question receipt');
    const updated = createQuestionView(inboxQuestion({ ...question, status, continuationTurnId }));
    questionViews.set(id, updated);
    row.replaceWith(updated.row);
    inboxStatus.textContent = body.decline ? 'Question declined.' : 'Answer sent.';
    if (restoreFocus && !inboxPanel.hidden && document.activeElement === document.body) {
      (updated.continuationButton ?? updated.row).focus();
    }
  } catch (error) {
    // A lost response or a conflict can mean the question was already resolved. Read
    // the latest state before allowing another response; never replay a POST ourselves.
    verifyInboxBeforeResponding = !error.status || error.status >= 500 || [404, 408, 409].includes(error.status);
    inboxStatus.textContent = verifyInboxBeforeResponding
      ? `${failure(error)} Use “Refresh inbox” to check the question before retrying.`
      : `${failure(error)} Review your response and try again.`;
  } finally {
    setInboxBusy(false);
  }
}

async function viewContinuation(id, button, notice) {
  if (chatBusy) {
    notice.textContent = 'Chat is busy. Try again after the current Chat request finishes.';
    return;
  }
  button.disabled = true;
  notice.textContent = 'Refreshing Chat…';
  try {
    if (!await refreshHistory()) {
      notice.textContent = 'Could not refresh Chat. Use “Refresh and view in Chat” to try again.';
      return;
    }
    const row = chatRows.get(id)?.row;
    if (!row) {
      notice.textContent = 'The continuation is not in recent Chat history. Try refreshing again.';
      return;
    }
    notice.textContent = '';
    // Do not steal the tab if the owner left the Inbox while history loaded.
    if (!inboxPanel.hidden && button.isConnected) {
      showTab(byId('chat-tab'));
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'start' });
    }
  } finally {
    button.disabled = false;
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
const chatRows = new Map();

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

const SESSIONS_PATH = '/api/sessions';
const SESSION_STATUS = new Map([
  ['queued', 'Queued'], ['running', 'Running'], ['waiting', 'Waiting'], ['done', 'Done'], ['failed', 'Failed'],
]);
const ACTIVE_SESSION_STATES = new Set(['queued', 'running', 'waiting']);
const sessionsTab = byId('sessions-tab');
const sessionListView = byId('sessions-list-view');
const sessionList = byId('session-list');
const sessionsStatus = byId('sessions-status');
const includeEnded = byId('include-ended');
const sessionDetail = byId('session-detail');
const sessionTitle = byId('session-title');
const sessionMeta = byId('session-meta');
const sessionDetailStatus = byId('session-detail-status');
const sessionTranscript = byId('session-transcript');
let sessions;
let sessionsByTurn = new Map();
let sessionsError = '';
let sessionsBlocked = false;
let sessionsRefreshing = false;
let queuedSessionsRefresh;
let sessionsPollUntil = 0;
let sessionsPollTimer;
let renderedSessionList;
let selectedSession;
let detailRequest;

function sessionSummary({ id, parentTurnId, title, status, target, blueprint }) {
  // An ID is a single URL path segment, never an endpoint or a navigation URL.
  if (typeof id !== 'string' || !id || id === '.' || id === '..') throw new Error('Invalid session ID');
  return {
    id, parentTurnId, status, blueprint: typeof blueprint?.id === 'string' ? blueprint.id : undefined,
    title: typeof title === 'string' && title.trim() ? title : 'Untitled session',
    target: typeof target === 'string' && target.trim() ? target : 'Not assigned',
  };
}

function sessionMetadata(session) {
  return [
    textNode('span', `Status: ${SESSION_STATUS.get(session.status) ?? 'Unknown'}`),
    textNode('span', `Target: ${session.target}`, 'plain-text'),
    ...(session.blueprint ? [textNode('span', `Blueprint: ${session.blueprint}`, 'plain-text')] : []),
  ];
}

function sessionButton(session, className) {
  const button = textNode('button', session.title, className);
  button.type = 'button';
  button.dataset.sessionId = session.id;
  button.addEventListener('click', () => {
    if (byId('sessions-panel').hidden) showTab(sessionsTab);
    openSession(session);
  });
  return button;
}

function renderChatSessionLinks(id, view) {
  const related = sessionsByTurn.get(id) ?? [];
  const key = JSON.stringify(related.map(({ id, title }) => [id, title]));
  if (key === view.relatedKey) return;
  view.relatedKey = key;
  view.links.replaceChildren(...related.map((session) => sessionButton(session, 'chat-session-link')));
  view.links.hidden = !related.length;
}

function focusSessionRow(id) {
  const button = [...sessionList.querySelectorAll('button')].find((row) => row.dataset.sessionId === id);
  (button ?? includeEnded).focus();
}

function renderSessionList() {
  const visible = (sessions ?? []).filter(({ status }) => includeEnded.checked || ACTIVE_SESSION_STATES.has(status));
  const key = JSON.stringify(visible);
  if (key !== renderedSessionList) {
    renderedSessionList = key;
    const focusedId = sessionList.contains(document.activeElement) && document.activeElement.dataset.sessionId;
    sessionList.replaceChildren(...visible.map((session) => {
      const row = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'session-meta';
      meta.append(...sessionMetadata(session));
      row.append(sessionButton(session, 'session-list-title'), meta);
      return row;
    }));
    if (focusedId) focusSessionRow(focusedId);
  }
  const emptyMessage = includeEnded.checked ? 'No sessions yet.' : 'No active sessions.';
  const message = sessionsError || (!sessions ? 'Loading sessions…' : visible.length ? '' : emptyMessage);
  if (sessionsStatus.textContent !== message) sessionsStatus.textContent = message;
}

function indexSessions() {
  sessionsByTurn = new Map();
  for (const session of sessions ?? []) {
    if (!session.parentTurnId) continue;
    const related = sessionsByTurn.get(session.parentTurnId) ?? [];
    related.push(session);
    sessionsByTurn.set(session.parentTurnId, related);
  }
  // Summary polling never rewrites the chat, scroll position or composer.
  for (const [id, view] of chatRows) renderChatSessionLinks(id, view);
}

function sessionAccessDenied(error) {
  return error.status === 401 || error.status === 403;
}

function clearSessionDetail(message) {
  detailRequest = undefined;
  sessionTitle.textContent = 'Session';
  sessionMeta.replaceChildren();
  sessionTranscript.replaceChildren();
  sessionDetailStatus.textContent = message;
}

async function refreshSessions({ force = false, afterCurrent = false } = {}) {
  if (sessionsBlocked && !force) return;
  if (sessionsRefreshing) {
    if (afterCurrent || force) queuedSessionsRefresh = { force: force || queuedSessionsRefresh?.force };
    return;
  }
  clearTimeout(sessionsPollTimer);
  sessionsRefreshing = true;
  if (force || (!sessions && !sessionsError)) sessionsStatus.textContent = 'Loading sessions…';
  try {
    const result = await api(SESSIONS_PATH);
    sessions = result.sessions.map(sessionSummary);
    sessionsBlocked = false;
    sessionsError = '';
  } catch (error) {
    const unavailable = [404, 405, 501].includes(error.status);
    const denied = sessionAccessDenied(error);
    sessionsBlocked = unavailable || denied;
    sessionsError = unavailable ? 'Sessions are not available on this relay.'
      : denied ? 'Sign in as an owner and try again.'
      : `${failure(error)} Use “Refresh sessions” to try again.`;
    if (sessionsBlocked) {
      sessions = undefined;
      if (selectedSession) clearSessionDetail(sessionsError);
    }
  } finally {
    indexSessions();
    renderSessionList();
    sessionsRefreshing = false;
    if (queuedSessionsRefresh) {
      const next = queuedSessionsRefresh;
      queuedSessionsRefresh = undefined;
      void refreshSessions(next);
    } else if (!sessionsBlocked && pendingTurn() && performance.now() < sessionsPollUntil) {
      // Separate from turn polling: summary errors can't change its cadence or end it.
      sessionsPollTimer = setTimeout(() => {
        if (pendingTurn() && performance.now() < sessionsPollUntil) void refreshSessions();
      }, sessionsError ? 15_000 : 2_000);
    }
  }
}

async function refreshSessionDetail() {
  const id = selectedSession;
  const request = Symbol();
  detailRequest = request;
  sessionDetailStatus.textContent = 'Loading transcript…';
  try {
    const { session } = await api(`${SESSIONS_PATH}/${encodeURIComponent(id)}`);
    if (detailRequest !== request) return; // Navigation or an authorization error superseded this read.
    const summary = sessionSummary(session);
    if (summary.id !== id) throw new Error('Unexpected session ID');
    const rows = session.transcript.map(({ role, text }) => {
      const row = document.createElement('li');
      row.append(textNode('strong', role, 'plain-text'), textNode('p', text, 'plain-text'));
      return row;
    });
    sessionTitle.textContent = summary.title;
    sessionMeta.replaceChildren(...sessionMetadata(summary));
    sessionTranscript.replaceChildren(...rows);
    sessionDetailStatus.textContent = rows.length ? '' : 'No transcript yet.';
  } catch (error) {
    if (detailRequest !== request) return;
    clearSessionDetail(error.status === 404 ? 'This session is no longer available.'
      : sessionAccessDenied(error) ? 'Sign in as an owner and try again.'
      : `${failure(error)} Use “Refresh sessions” to try again.`);
  }
}

function openSession(session) {
  selectedSession = session.id;
  sessionTitle.textContent = session.title;
  sessionMeta.replaceChildren(...sessionMetadata(session));
  sessionTranscript.replaceChildren();
  sessionListView.hidden = true;
  sessionDetail.hidden = false;
  sessionTitle.focus();
  void refreshSessionDetail();
}

byId('back-to-sessions').addEventListener('click', () => {
  const id = selectedSession;
  selectedSession = undefined;
  clearSessionDetail('');
  sessionDetail.hidden = true;
  sessionListView.hidden = false;
  focusSessionRow(id);
});
includeEnded.addEventListener('change', renderSessionList);
byId('refresh-sessions').addEventListener('click', () => {
  void refreshSessions({ force: true });
  if (selectedSession) void refreshSessionDetail();
});

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

function pendingActivityLabel(activity) {
  if (activity === 'queued') return 'Queued.';
  if (activity === 'running') return 'Running.';
  return 'Reply pending.';
}

function renderChatAnswer({ id, status, activity, reply, tools, live }) {
  const answer = document.createElement('div');
  answer.className = 'chat-answer';
  answer.dataset.state = status;
  answer.append(textNode('strong', 'Manolo'));
  if (status === 'done') {
    if (Array.isArray(tools) && tools.length > 0) answer.append(renderTools(tools, id));
    answer.append(textNode('div', reply ?? '(No reply text.)', 'plain-text'));
  } else {
    const message = status === 'failed' ? 'Turn failed.' : pendingActivityLabel(activity);
    answer.append(textNode('div', message, 'chat-turn-state'));
    if (status === 'failed' && reply) answer.append(textNode('div', reply, 'plain-text'));
    if (status === 'pending' && live) {
      if (live.thinking) answer.append(renderThinking(live.thinking));
      if (live.tools?.length) answer.append(renderTools(live.tools, id));
      if (live.text) answer.append(textNode('div', live.text, 'chat-stream plain-text'));
      if (live.retry) answer.append(textNode('div', 'Retrying the model request…', 'chat-turn-state'));
    }
  }
  return answer;
}

function renderHistory() {
  const visible = [...turns.values()].slice(-HISTORY_LIMIT);
  const visibleIds = new Set(visible.map(({ id }) => id));
  for (const [id, { row }] of chatRows) {
    if (visibleIds.has(id)) continue;
    row.remove();
    chatRows.delete(id);
  }
  for (const [index, turn] of visible.entries()) {
    const { id, text } = turn;
    let view = chatRows.get(id);
    if (!view) {
      const row = document.createElement('li');
      row.className = 'chat-turn';
      const prompt = textNode('div', text, 'chat-prompt plain-text');
      const answer = renderChatAnswer(turn);
      const links = document.createElement('div');
      links.className = 'chat-session-links';
      links.setAttribute('role', 'group');
      links.setAttribute('aria-label', 'Related sessions');
      row.append(textNode('strong', 'You', 'chat-user'), prompt, answer, links);
      view = { row, turn, prompt, answer, links };
      chatRows.set(id, view);
      renderChatSessionLinks(id, view);
    } else if (view.turn !== turn) {
      // Keep work links intact (including keyboard focus) while live chat updates the answer.
      view.prompt.textContent = text;
      const answer = renderChatAnswer(turn);
      view.answer.replaceWith(answer);
      view.answer = answer;
      view.turn = turn;
    }
    const atIndex = chatLog.children[index];
    if (view.row !== atIndex) chatLog.insertBefore(view.row, atIndex ?? null);
  }
  chatEmpty.hidden = !historyLoaded || visible.length > 0;
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
    if (pendingTurn()) sessionsPollUntil = performance.now() + POLL_WINDOW_MS;
    void refreshSessions({ afterCurrent: true });
    chatStatus.textContent = notSaved
      ? 'The last submission was not found in history. Review before retrying. ' + idleChatStatus()
      : idleChatStatus();
    return true;
  } catch (error) {
    chatStatus.textContent = `${failure(error)} Use “Refresh history” to try again.`;
    return false;
  } finally {
    setChatBusy(false);
  }
}

function recordTurnStatus(id, result) {
  if (!['done', 'failed', 'pending'].includes(result?.status)) throw new Error('Unexpected turn status');
  if (unconfirmedTurn?.id === id) unconfirmedTurn = undefined;
  const turn = turns.get(id);
  if (result.status === 'pending') {
    const { activity } = result;
    // A status-only update should not discard the last live output.
    const live = result.live ?? turn.live;
    if (activity !== turn.activity || live !== turn.live) {
      turns.set(id, { ...turn, activity, live });
      renderHistory();
    }
    return;
  }
  turns.set(id, {
    ...turn, status: result.status, activity: undefined, live: undefined,
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
    recordTurnStatus(id, result);
    // Stream while the turn runs: poll the relay faster than history refreshes, but never more than the window.
    const deadline = performance.now() + POLL_WINDOW_MS;
    sessionsPollUntil = deadline;
    void refreshSessions({ afterCurrent: true });
    while (result.status === 'pending') {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) break;
      result = await api(path, 'GET', undefined, Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, left)));
      recordTurnStatus(id, result);
      if (result.status !== 'pending') void refreshSessions({ afterCurrent: true });
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
  const turn = { id: crypto.randomUUID(), text, status: 'pending', activity: 'queued' };
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

const sessionUser = byId('session-user');
const signOutButton = byId('sign-out');
const sessionStatus = byId('session-status');
let signingOut = false;

function showSignedIn(user) {
  sessionUser.textContent = user;
  sessionUser.dataset.state = 'signed-in';
  signOutButton.disabled = false;
}

async function loadSession() {
  try {
    const session = await api(SESSION_PATH);
    const { user } = session;
    if (typeof user !== 'string' || !user.trim()) throw new Error('Unexpected session response');
    showSignedIn(user);
    applyBrowserAvailability(Boolean(session.browser));
  } catch (error) {
    if (error.status === 401) return redirectToLogin();
    // Never guess a name: an unknown session stays neutral and says why.
    sessionUser.textContent = 'Unknown';
    sessionUser.dataset.state = 'unknown';
    sessionStatus.textContent = `${failure(error)} Reload the page to try again.`;
  }
}

async function signOut() {
  if (signingOut) return;
  signingOut = true;
  signOutButton.disabled = true;
  sessionStatus.textContent = 'Signing out…';
  try {
    // The relay requires the same request header its other state changes use.
    const result = await api(LOGOUT_PATH, 'POST', {});
    if (result?.ok !== true) throw new Error('Unexpected sign-out response');
    redirectToLogin();
  } catch (error) {
    // A 401 means the session already ended; api() has started the sign-in navigation.
    if (error.status === 401) return;
    signingOut = false;
    signOutButton.disabled = false;
    sessionStatus.textContent = `Could not sign out. ${failure(error)} You are still signed in.`;
  }
}

signOutButton.addEventListener('click', () => void signOut());

void loadSession();
void refreshDashboard();
const browserTab = byId('browser-tab');
const browserFrame = byId('browser-frame');
const browserStatus = byId('browser-status');
const reloadBrowserButton = byId('reload-browser');
let browserAvailable = false;

function openDesktop() {
  browserFrame.hidden = false;
  if (!browserFrame.getAttribute('src')) browserFrame.src = '/desktop/';
}

function applyBrowserAvailability(available) {
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

void refreshInbox();
void refreshHistory();
void refreshRuntimes();
void refreshMcp();
