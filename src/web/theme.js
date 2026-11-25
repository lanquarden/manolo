// Runs synchronously in <head>, before the workspace paints, so a reload never flashes the wrong palette. It is a
// classic (non-module) script on purpose: a module would be deferred and the first paint would use the default theme.
(() => {
  const THEMES = ['dark', 'solarized-light', 'solarized-dark'];
  const KEY = 'manolo.theme';
  const pick = () => {
    let stored;
    try { stored = localStorage.getItem(KEY); } catch { stored = undefined; }
    return THEMES.includes(stored) ? stored : 'dark';
  };
  document.documentElement.dataset.theme = pick();
  // app.js calls this after the owner chooses another palette. Storage can be unavailable; the choice still applies.
  globalThis.manoloTheme = {
    themes: THEMES,
    current: () => document.documentElement.dataset.theme,
    apply(theme) {
      const next = THEMES.includes(theme) ? theme : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
      return next;
    },
  };
})();
