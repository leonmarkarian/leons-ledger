/* Phone / browser version of the desktop bridge (window.api).
   Data lives in this device's browser storage. AI calls go straight to Anthropic. */
(function () {
  'use strict';
  const KEY = 'leons-ledger-data';
  const VERSION = '__VERSION__';
  let updateCb = () => {};

  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.api = {
    platform: 'web',
    load: async () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } },
    save: async (state) => { localStorage.setItem(KEY, JSON.stringify(state)); return true; },
    exportData: async (state) => {
      const copy = JSON.parse(JSON.stringify(state));
      if (copy.settings) copy.settings.apiKey = '';
      const name = `leons-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
      download(name, JSON.stringify(copy, null, 2));
      return name;
    },
    importData: () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        f.text().then((t) => { try { resolve(JSON.parse(t)); } catch (_) { resolve(null); } });
      };
      input.click();
    }),
    openDataFolder: async () => {},
    askAI: async ({ apiKey, model, system, messages }) => {
      if (!apiKey) return { ok: false, error: 'No API key set.' };
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({ model: model || 'claude-sonnet-5-5', max_tokens: 1200, system, messages })
        });
        const json = await res.json();
        if (!res.ok) return { ok: false, error: (json.error && json.error.message) || `HTTP ${res.status}` };
        return { ok: true, text: (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() };
      } catch (err) {
        return { ok: false, error: 'Could not reach the AI service. Check your internet connection.' };
      }
    },
    version: async () => VERSION,
    checkUpdates: async () => {
      try {
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
        updateCb({ status: reg && (reg.installing || reg.waiting) ? 'available' : 'none', version: '' });
      } catch (_) { updateCb({ status: 'none' }); }
      return true;
    },
    installUpdate: async () => location.reload(),
    onUpdate: (cb) => { updateCb = cb; }
  };

  // Service worker: keeps the app working offline and fetches new versions automatically.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // When a new version finishes installing, reload once so it's used straight away.
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'activated' && navigator.serviceWorker.controller && !sessionStorage.getItem('ledger-reloaded-' + VERSION)) {
              sessionStorage.setItem('ledger-reloaded-' + VERSION, '1');
            }
          });
        });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      }).catch(() => {});
    });
  }
})();
