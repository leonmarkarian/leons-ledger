/* Leon's Ledger — renderer */
(function () {
  'use strict';
  const L = window.Ledger;

  // Browser fallback so the UI also runs outside Electron (localStorage, no AI calls).
  const api = window.api || {
    load: async () => { try { return JSON.parse(localStorage.getItem('ledger')); } catch (_) { return null; } },
    save: async (s) => { localStorage.setItem('ledger', JSON.stringify(s)); return true; },
    exportData: async () => false, importData: async () => null, openDataFolder: async () => {},
    askAI: async () => ({ ok: false, error: 'AI is only available in the desktop app.' }),
    version: async () => 'web', checkUpdates: async () => false, installUpdate: async () => {}, onUpdate: () => {}
  };

  let state = null;
  let page = 'dashboard';
  let draftPlan = null;        // copy of sections while editing the plan
  let lastPaymentMsg = null;
  let lastIncomeId = null;
  let aiBusy = false;
  let historyFilter = 'all';
  let spendTab = 'spend';
  let manualUpdateCheck = false;
  let reportRange = 6;
  let goalExtras = {};
  let debtBudget = null;
  let debtStrategy = 'avalanche';
  let scanBusy = false;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const m = (n) => L.money(n, state);
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[\s,]/g, (c) => (c === ',' ? '.' : '')).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const sym = () => esc(state.settings.currencySymbol || '$');

  // Storage: one file holds every budget on this device (your own + shared ones).
  let root = null;
  let apiBase = null;
  let syncState = { status: 'off', at: 0, msg: '' };
  let syncTimer = null;
  let remoteBooks = null;
  const DISCOVERY = location.protocol === 'file:' ? 'https://leonmarkarian.github.io/leons-ledger/api.json' : './api.json';

  function loadRoot(raw) {
    if (raw && raw.books) root = raw;
    else root = { v: 2, active: 'local', books: { local: raw }, meta: { local: { name: 'My budget' } }, account: null, device: {} };
    root.meta = root.meta || {}; root.device = root.device || {};
    if (!root.deviceId) root.deviceId = L.uid('dev');
    Object.keys(root.books).forEach((k) => { root.books[k] = L.migrate(root.books[k]); root.meta[k] = root.meta[k] || { name: k === 'local' ? 'My budget' : 'Shared budget' }; });
    // device-only settings (theme, PIN, own API key) live on the device, not in a budget
    L.DEVICE_KEYS.forEach((k) => { if (root.device[k] == null) root.device[k] = root.books.local.settings[k]; });
    if (!root.books[root.active]) root.active = 'local';
    useBook(root.active);
  }
  function useBook(key) {
    root.active = key; state = root.books[key];
    L.DEVICE_KEYS.forEach((k) => { state.settings[k] = root.device[k]; });
  }
  async function persist(opts) {
    L.DEVICE_KEYS.forEach((k) => { root.device[k] = state.settings[k]; });
    await api.save(root);
    if (!(opts && opts.noSync)) scheduleSync();
  }
  const whoAmI = () => (root && root.account ? root.account.username : undefined);
  const isShared = () => !!(root && root.meta[root.active] && root.meta[root.active].shared);
  const nice = (u) => (u ? u.charAt(0).toUpperCase() + u.slice(1) : '');
  function byTag(x) { return isShared() && x.by ? `by ${nice(x.by)}` : ''; }
  function markDeleted(id) { state.deleted = state.deleted || {}; state.deleted[id] = Date.now(); }

  // ---------- server ----------
  async function discover() {
    try { const r = await fetch(DISCOVERY + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && j.url) { apiBase = j.url.replace(/\/$/, ''); root.apiUrl = apiBase; } } }
    catch (_) { apiBase = root.apiUrl || null; }
    if (!apiBase) apiBase = root.apiUrl || null;
  }
  async function call(method, path, body) {
    if (!apiBase) throw new Error('The online service isn’t available yet.');
    const headers = { 'content-type': 'application/json', 'x-device-id': root.deviceId };
    if (root.account && root.account.token) headers.authorization = 'Bearer ' + root.account.token;
    let res;
    try { res = await fetch(apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch (_) { throw Object.assign(new Error('No internet connection.'), { offline: true }); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && root.account && path !== '/auth/login') { root.account = null; await api.save(root); }
      throw Object.assign(new Error(j.error || 'HTTP ' + res.status), { status: res.status, data: j });
    }
    return j;
  }

  function scheduleSync(delay) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncActive(), delay == null ? 2500 : delay); }
  async function syncActive() {
    const key = root.active, meta = root.meta[key];
    if (!root.account || !meta || !meta.remoteId || !apiBase) { syncState.status = root.account ? 'local' : 'off'; drawSync(); return false; }
    syncState.status = 'syncing'; drawSync();
    try {
      let changed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await call('GET', '/books/' + meta.remoteId);
        const before = JSON.stringify(L.forUpload(root.books[key]));
        const merged = L.mergeStates(root.books[key], remote.data);
        root.books[key] = merged; if (root.active === key) useBook(key);
        if (JSON.stringify(L.forUpload(merged)) !== before) changed = true;
        meta.name = remote.name || meta.name;
        if (JSON.stringify(L.forUpload(merged)) === JSON.stringify(L.forUpload(L.migrate(remote.data)))) { meta.rev = remote.rev; break; }
        try { const r = await call('PUT', '/books/' + meta.remoteId, { baseRev: remote.rev, data: L.forUpload(merged) }); meta.rev = r.rev; break; }
        catch (e) { if (e.status !== 409) throw e; }
      }
      if (meta.shared && (!meta.membersAt || Date.now() - meta.membersAt > 5 * 60 * 1000)) {
        try { const r = await call('GET', '/books/' + meta.remoteId + '/members'); meta.members = r.members.map((x) => x.username); meta.membersAt = Date.now(); changed = true; } catch (_) {}
      }
      await persist({ noSync: true });
      syncState = { status: 'ok', at: Date.now(), msg: '' }; drawSync();
      if (changed && !document.querySelector('main input:focus, main textarea:focus, main select:focus, .modal')) render();
      return changed;
    } catch (e) {
      syncState = { status: e.offline ? 'offline' : 'error', at: Date.now(), msg: e.message }; drawSync();
      return false;
    }
  }
  function drawSync() {
    const el = $('#syncPill'); if (!el) return;
    const map = { off: '', local: '', syncing: '⟳ Syncing…', ok: '✓ Synced', offline: '○ Offline — will sync later', error: '⚠ ' + syncState.msg };
    el.textContent = map[syncState.status] || ''; el.className = 'sync-pill ' + syncState.status;
    const sw = $('#bookSwitch');
    if (sw) {
      const keys = Object.keys(root.books);
      sw.classList.toggle('hidden', keys.length < 2);
      sw.innerHTML = keys.map((k) => `<option value="${k}" ${k === root.active ? 'selected' : ''}>${esc(root.meta[k].name || 'Budget')}${root.meta[k].shared ? ' 👥' : ''}</option>`).join('');
    }
  }
  async function switchBook(key) {
    await persist({ noSync: true }); useBook(key); applyTheme(); draftPlan = null; render(); animateEntrance(); drawSync(); syncActive();
  }

  function toast(text, isErr) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 5000);
  }

  function modal(html, onMount) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    const close = () => { root.innerHTML = ''; };
    $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
    if (onMount) onMount($('.modal', root), close);
    return close;
  }

  function confirmBox(title, text, okLabel) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
        <div class="row" style="justify-content:flex-end;margin-top:20px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${esc(okLabel || 'Confirm')}</button></div>`,
      (el, close) => {
        $('[data-x]', el).onclick = () => { close(); resolve(false); };
        $('[data-ok]', el).onclick = () => { close(); resolve(true); };
      });
    });
  }

  function categoryOptions(selected) {
    return state.sections.map((s) => `<optgroup label="${esc(s.name)}">${s.categories.map((c) => {
      const v = s.id + '|' + c.id;
      return `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(s.name)} → ${esc(c.name)}</option>`;
    }).join('')}</optgroup>`).join('');
  }

  function walletOptions(selected) {
    return state.settings.wallets.map((w) => `<option value="${w.id}" ${w.id === selected ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  }
  const walletName = (id) => { const w = state.settings.wallets.find((x) => x.id === id); return w ? w.name : ''; };
  function currencySelect(id) {
    return `<select id="${id}" class="cur-select" title="Currency"><option value="USD">${esc(state.settings.currency || 'USD')}</option><option value="LBP">LBP</option></select>`;
  }
  function readAmount(amountSel, curSel) {
    const raw = num($(amountSel).value);
    const cur = $(curSel) ? $(curSel).value : 'USD';
    const usd = L.toUSD(raw, cur, state.settings.lbpRate);
    return { usd, original: cur === 'LBP' ? { amount: raw, currency: 'LBP', rate: state.settings.lbpRate } : null, raw, cur };
  }
  const ord = (n) => { n = Number(n); const sfx = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]); };
  const lbp = (n) => 'LBP ' + Math.round(n).toLocaleString('en-US');

  function applyTheme() {
    const t = state.settings.theme || 'black';
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000');
  }

  // ---------------- AI ----------------
  function systemPrompt() {
    return [
      "You are the built-in financial advisor inside Leon's Ledger, a personal budgeting app." + (state.settings.userName ? ` The user's name is ${state.settings.userName}.` : ''),
      'You see their split plan (sections and categories with percentages), current balances, debts, goals, wallets and recent activity.',
      'Give practical, specific, encouraging but honest advice in plain language. Use their real numbers. Keep it concise:',
      'short paragraphs or a few bullet points, no tables, no markdown headers. Suggest concrete amounts or percentage changes when useful.',
      'You are not a licensed financial advisor: do not recommend specific stocks, coins or trades; talk about strategy (debt payoff order, emergency fund, diversification, savings rate, goal timelines).'
    ].join(' ');
  }

  // Your own key if you set one, otherwise the built-in AI (server, daily limit)
  async function aiRequest(system, messages) {
    const s = state.settings;
    if (s.apiKey) return api.askAI({ apiKey: s.apiKey, model: s.model, system, messages });
    try { const r = await call('POST', '/ai', { system, messages }); return { ok: true, text: r.text }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  async function askAdvisor(messages, focusIncome) {
    const s = state.settings;
    if (!s.aiEnabled || (!s.apiKey && !apiBase)) return { ok: false, offline: true, text: L.fallbackAdvice(state, focusIncome) };
    const context = L.summaryForAI(state, focusIncome);
    const msgs = messages.map((x) => ({ role: x.role, content: x.content }));
    msgs[0] = { role: msgs[0].role, content: `Here is my current financial picture:\n\n${context}\n\n---\n\n${msgs[0].content}` };
    const res = await aiRequest(systemPrompt(), msgs);
    if (!res.ok) return { ok: false, error: res.error, text: L.fallbackAdvice(state, focusIncome) + `\n\n⚠ AI unavailable: ${res.error}` };
    return { ok: true, text: res.text };
  }

  async function adviseOnIncome(income) {
    aiBusy = true; render();
    const res = await askAdvisor([{ role: 'user', content: `I just got paid ${m(income.amount)}${income.source ? ' from ' + income.source : ''}. Give me your opinion on this income and how it was split: is the split smart given my debts, goals and spending so far? What should I prioritise until the next income? Mention anything I should change in my percentages.` }], income);
    const inc = state.incomes.find((i) => i.id === income.id);
    if (inc) { inc.advice = res.text; inc.adviceOffline = !res.ok; }
    aiBusy = false;
    await persist();
    render();
  }

  // ---------------- Receipt scanning ----------------
  function imageToJpegBase64(file, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, (maxSide || 1280) / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')); };
      img.src = url;
    });
  }

  async function scanReceipt(file) {
    const st = state.settings;
    if (!st.aiEnabled || (!st.apiKey && !apiBase)) return toast('Receipt scanning needs the AI — turn it on in Settings (and be online).', true);
    scanBusy = true; render();
    try {
      const data = await imageToJpegBase64(file, 1280);
      const cats = state.sections.flatMap((s) => s.categories.map((c) => `${s.name} → ${c.name}`));
      const prompt = `Read this receipt, invoice or payment screenshot. Reply with ONLY a JSON object, no other text:
{"amount": number (the total paid), "currency": "USD" or "LBP", "date": "YYYY-MM-DD" or null, "merchant": short name, "category": the best match from this list or null: ${JSON.stringify(cats)}}`;
      const res = await aiRequest('You extract payment details from images. Output strict JSON only.', [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text: prompt }] }]);
      if (!res.ok) throw new Error(res.error);
      const json = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      scanBusy = false; render();
      if (json.amount) $('#spAmount').value = json.amount;
      if (json.currency === 'LBP') $('#spCur').value = 'LBP';
      if (json.date && /^\d{4}-\d{2}-\d{2}$/.test(json.date)) $('#spDate').value = json.date;
      if (json.merchant) $('#spNote').value = json.merchant;
      if (json.category) {
        const opt = Array.from($('#spCat').options).find((o) => o.text === json.category);
        if (opt) { $('#spCat').value = opt.value; $('#spCat').dispatchEvent(new Event('change')); }
      }
      $('#spAmount').dispatchEvent(new Event('input'));
      toast(json.amount ? 'Receipt read — check the details, then press Save.' : "Couldn't find a total on that image. Please type it in.", !json.amount);
    } catch (e) {
      scanBusy = false; render();
      toast('Could not read the receipt: ' + e.message, true);
    }
  }

  // ---------------- Charts (SVG, no libraries) ----------------
  function barChart(series) {
    const W = 640, H = 220, pad = { l: 44, r: 8, t: 10, b: 26 };
    const max = Math.max(1, ...series.map((r) => Math.max(r.income, r.out)));
    const n = series.length, gw = (W - pad.l - pad.r) / n, bw = Math.min(22, gw * 0.34);
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const ticks = [0, 0.5, 1].map((k) => max * k);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Income and spending per month">
      ${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid-line"/><text x="${pad.l - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${shortMoney(t)}</text>`).join('')}
      ${series.map((r, i) => { const x = pad.l + gw * i + gw / 2;
        return `<g><title>${L.monthLabel(r.month)}: in ${m(r.income)}, out ${m(r.out)}</title>
          <rect x="${x - bw - 1}" y="${y(r.income)}" width="${bw}" height="${Math.max(0, H - pad.b - y(r.income))}" rx="4" class="bar-in"/>
          <rect x="${x + 1}" y="${y(r.out)}" width="${bw}" height="${Math.max(0, H - pad.b - y(r.out))}" rx="4" class="bar-out"/>
          <text x="${x}" y="${H - 8}" class="axis" text-anchor="middle">${L.monthLabel(r.month).split(' ')[0]}</text></g>`; }).join('')}
    </svg>`;
  }
  function lineChart(series) {
    const W = 640, H = 180, pad = { l: 44, r: 10, t: 12, b: 24 };
    const vals = series.map((r) => r.cumulative);
    const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
    const x = (i) => pad.l + (W - pad.l - pad.r) * (series.length === 1 ? 0.5 : i / (series.length - 1));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min || 1));
    const pts = series.map((r, i) => `${x(i)},${y(r.cumulative)}`).join(' ');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Balance over time">
      <defs><linearGradient id="lg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="lg-top"/><stop offset="1" class="lg-bot"/></linearGradient></defs>
      ${[min, (min + max) / 2, max].map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid-line"/><text x="${pad.l - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${shortMoney(t)}</text>`).join('')}
      <polygon points="${x(0)},${y(min)} ${pts} ${x(series.length - 1)},${y(min)}" fill="url(#lg)"/>
      <polyline points="${pts}" class="line"/>
      ${series.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.cumulative)}" r="3.5" class="dot"><title>${L.monthLabel(r.month)}: ${m(r.cumulative)}</title></circle>`).join('')}
      ${series.map((r, i) => (series.length <= 12 || i % 2 === 0) ? `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${L.monthLabel(r.month).split(' ')[0]}</text>` : '').join('')}
    </svg>`;
  }
  const shortMoney = (v) => { const a = Math.abs(v), sg = v < 0 ? '-' : ''; const sy = state.settings.currencySymbol || '$';
    return a >= 1e6 ? `${sg}${sy}${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${sg}${sy}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `${sg}${sy}${Math.round(a)}`; };

  const md = (t) => L.mdToHtml(t);
  const avatar = () => `<div class="av">${$('.brand .logo') ? $('.brand .logo').innerHTML : ''}</div>`;

  // ---------------- Pages ----------------
  const pages = {
    dashboard() {
      const b = L.balances(state);
      const latest = state.incomes[state.incomes.length - 1];
      const recent = activity().slice(0, 6);
      const bizSecs = b.sections.filter((s) => s.type === 'business');
      const bizAvail = L.round2(L.sum(bizSecs, (s) => s.available));
      const personalAvail = L.round2(b.totalAvailable - bizAvail);
      const wallets = L.walletBalances(state);
      const due = L.dueRecurring(state).filter((r) => !r.auto);
      const soon = L.upcomingRecurring(state, null, 3);
      return `
        ${Object.keys(root.books).length > 1 ? `<div class="mobile-book"><select id="bookSwitch2">${Object.keys(root.books).map((k) => `<option value="${k}" ${k === root.active ? 'selected' : ''}>${esc(root.meta[k].name || 'Budget')}${root.meta[k].shared ? ' 👥' : ''}</option>`).join('')}</select></div>` : ''}
        <div class="row between"><div><h1>Dashboard${root.meta[root.active].shared ? ` <span class="tag">👥 ${esc(root.meta[root.active].name)}</span>` : ''}</h1>${root.meta[root.active].shared && root.meta[root.active].members ? `<div class="members">${root.meta[root.active].members.map((u) => `<span class="avatar" title="${esc(u)}">${esc(u.charAt(0).toUpperCase())}</span>`).join('')}<span class="muted small">${root.meta[root.active].members.map(nice).map(esc).join(' & ')}</span></div>` : ''}<p class="sub">Where your money is right now.${syncState.status === 'ok' ? ' <span class="good small">✓ Synced</span>' : syncState.status === 'offline' ? ' <span class="muted small">○ Offline</span>' : ''}</p></div>
          <div class="row"><button class="btn" data-go="spend">− Spend / Pay</button><button class="btn primary" data-go="income">＋ Log income</button></div></div>
        <div class="grid g3">
          <div class="card stat"><div class="label">Available${bizSecs.length ? ' (personal)' : ' across all buckets'}</div><div class="value ${personalAvail < 0 ? 'bad' : ''}" data-count="${personalAvail}">${m(personalAvail)}</div>${bizSecs.length ? `<div class="muted small mt-s">Business kept separate: <b>${m(bizAvail)}</b></div>` : ''}</div>
          <div class="card stat"><div class="label">Total income logged</div><div class="value good" data-count="${b.totalIncome}">${m(b.totalIncome)}</div><div class="muted small mt-s">${state.incomes.length} payment${state.incomes.length === 1 ? '' : 's'}</div></div>
          <div class="card stat"><div class="label">Spent & paid</div><div class="value" data-count="${b.totalSpent}">${m(b.totalSpent)}</div><div class="muted small mt-s">${state.transactions.length} entr${state.transactions.length === 1 ? 'y' : 'ies'}</div></div>
        </div>
        ${due.length || soon.length ? `<div class="card mt due-card"><h2>🔔 Bills</h2>
          ${due.map((r) => `<div class="row between due-row"><div><b>${esc(r.name)}</b> <span class="muted small">due on the ${ord(r.day)} · ${m(r.amount)}</span></div><button class="btn sm primary" data-paydue="${r.id}">Mark paid</button></div>`).join('')}
          ${soon.map((r) => `<div class="row between due-row"><div>${esc(r.name)} <span class="muted small">coming up on the ${ord(r.day)} · ${m(r.amount)}${r.auto ? ' · logs automatically' : ''}</span></div></div>`).join('')}
        </div>` : ''}
        <div class="card mt"><div class="row between"><h2>Wallets</h2><button class="btn sm ghost" data-go="settings">Manage</button></div>
          <div class="wallets">${wallets.map((w) => `<div class="wallet"><div class="muted small">${esc(w.name)}</div><div class="w-bal ${w.balance < 0 ? 'bad' : ''}">${m(w.balance)}</div></div>`).join('')}</div>
        </div>
        <div class="card mt"><div class="row between"><h2>Your split plan</h2><button class="btn sm ghost" data-go="plan">Edit plan</button></div>
          <div class="split-bar">${state.sections.map((s) => `<i style="width:${s.percent}%;background:${s.color}" title="${esc(s.name)} ${s.percent}%"></i>`).join('')}</div>
          <div class="legend">${state.sections.map((s) => `<span><b style="background:${s.color}"></b>${esc(s.name)} ${s.percent}%</span>`).join('')}</div>
        </div>
        ${latest && (latest.advice || aiBusy) ? `<div class="card advice-card mt"><div class="row between"><h2>✦ Advisor on your last income (${m(latest.amount)}, ${fmtDate(latest.date)})</h2>
            <button class="btn sm ghost" data-reask="${latest.id}" ${aiBusy ? 'disabled' : ''}>Refresh advice</button></div>
          <div class="advice md">${aiBusy && !latest.advice ? '<span class="typing">Thinking about your money…</span>' : md(latest.advice || 'No advice yet — click Refresh advice.')}</div>
          ${aiBusy && latest.advice ? '<div class="typing mt-s">Updating…</div>' : ''}</div>` : ''}
        <div class="grid g2 mt">${b.sections.map(sectionCard).join('')}</div>
        <div class="card mt"><div class="row between"><h2>Recent activity</h2><button class="btn sm ghost" data-go="history">See all</button></div>
          ${recent.length ? activityTable(recent, false) : '<div class="empty">Nothing logged yet. Start by logging an income.</div>'}</div>`;
    },

    income() {
      const preview = incomePreviewHtml(0);
      return `<h1>Log income</h1><p class="sub">Enter what you got paid. It's split automatically by your plan — tweak it for this payment if you want.</p>
        <div class="grid g12">
          <div class="card">
            <label class="f">Amount received<div class="amount-row"><input class="big" id="incAmount" type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" placeholder="0.00" autofocus>${currencySelect('incCur')}</div></label>
            <div class="small muted mt-s" id="incConv"></div>
            <div class="form-grid mt">
              <label class="f">Date<input id="incDate" type="date" value="${today()}"></label>
              <label class="f">Received into<select id="incWallet">${walletOptions()}</select></label>
              <label class="f">Source<input id="incSource" placeholder="e.g. Agency salary, freelance"></label>
              <label class="f full">Note<input id="incNote" placeholder="Optional"></label>
            </div>
            <label class="row mt small muted"><input type="checkbox" id="incCustom"> Adjust section percentages for this income only</label>
            <div class="errors mt-s" id="incErr"></div>
            <button class="btn primary mt" id="incSave" style="width:100%">Save income & split it</button>
          </div>
          <div class="card"><h2>Split preview</h2><div id="incPreview">${preview}</div></div>
        </div>
        ${lastIncomeId ? lastIncomeAdviceHtml() : ''}`;
    },

    spend() {
      return `<h1>Spend / Pay</h1><p class="sub">Log money leaving a bucket — a purchase, a debt payment, an investment — or move money between buckets.</p>
        <div class="tabs">${[['spend', 'Spend / Pay'], ['transfer', 'Move between buckets'], ['wallet', 'Move between wallets'], ['recurring', 'Recurring bills']].map(([k, l]) => `<button data-tab="${k}" class="${spendTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        ${({ spend: spendForm, transfer: transferForm, wallet: walletTransferForm, recurring: recurringPanel })[spendTab]()}
        ${lastPaymentMsg ? `<div class="card result-card mt">✓ ${esc(lastPaymentMsg)}</div>` : ''}`;
    },

    plan() {
      if (!draftPlan) draftPlan = JSON.parse(JSON.stringify(state.sections));
      const v = L.validatePlan(draftPlan);
      const types = Object.entries(L.SECTION_TYPES);
      return `<div class="sticky-bar"><div class="row between"><div><h1>Split plan</h1><p class="sub" style="margin:0">Sections get a % of each income; categories get a % of their section. Edit anything.</p></div>
          <div class="row"><button class="btn ghost" id="planReset">Discard changes</button><button class="btn" id="planAddSec">＋ Add section</button><button class="btn primary" id="planSave" ${v.ok ? '' : 'disabled'}>Save plan</button></div></div>
          <div class="row mt-s between"><div class="small">Sections total: <b id="planTotal" class="${Math.abs(v.total - 100) < 0.001 ? 'good' : 'bad'}">${v.total}%</b></div>
          <div class="errors" id="planErrors">${v.errors.map((e) => `<div>• ${esc(e)}</div>`).join('')}</div></div></div>
        ${draftPlan.map((s, si) => {
          const ct = L.round2(L.sum(s.categories, (c) => Number(c.percent) || 0));
          return `<div class="plan-sec" style="--c:${s.color}">
            <div class="plan-sec-head">
              <input type="color" value="${s.color}" data-s="${si}" data-k="color">
              <input value="${esc(s.name)}" data-s="${si}" data-k="name" placeholder="Section name">
              <select data-s="${si}" data-k="type">${types.map(([k, t]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
              <div class="pct-input"><input type="text" inputmode="decimal" autocomplete="off" min="0" max="100" step="0.5" value="${s.percent}" data-s="${si}" data-k="percent"></div>
              <button class="icon-btn" data-delsec="${si}" title="Delete section">✕</button>
            </div>
            <div class="plan-cats">
              <div class="plan-cat small muted"><span>Category</span><span>% of section</span><span>${s.type === 'debt' ? 'Total owed' : 'Goal (optional)'}</span><span>${s.type === 'debt' ? 'Interest % per year · Minimum payment' : 'Note'}</span><span></span></div>
              ${s.categories.map((c, ci) => `<div class="plan-cat">
                <input value="${esc(c.name)}" data-s="${si}" data-c="${ci}" data-k="name" placeholder="Category name">
                <div class="pct-input"><input type="text" inputmode="decimal" autocomplete="off" min="0" max="100" step="0.5" value="${c.percent}" data-s="${si}" data-c="${ci}" data-k="percent"></div>
                <div class="money-input" data-sym="${sym()}"><input type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" value="${c.target || ''}" placeholder="—" data-s="${si}" data-c="${ci}" data-k="target"></div>
                ${s.type === 'debt' ? `<div class="debt-extra"><div class="pct-input" title="Yearly interest rate"><input type="text" inputmode="decimal" autocomplete="off" min="0" step="0.1" value="${c.apr || ''}" placeholder="Interest/yr" data-s="${si}" data-c="${ci}" data-k="apr"></div>
                  <div class="money-input" data-sym="${sym()}" title="Minimum monthly payment"><input type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" value="${c.minPayment || ''}" placeholder="Min/month" data-s="${si}" data-c="${ci}" data-k="minPayment"></div></div>`
                  : `<input value="${esc(c.note || '')}" data-s="${si}" data-c="${ci}" data-k="note" placeholder="Optional">`}
                <button class="icon-btn" data-delcat="${si}|${ci}" title="Delete category">✕</button></div>`).join('')}
              <div class="row between"><button class="btn sm" data-addcat="${si}">＋ Add category</button>
                <span class="small">Categories total: <b data-cattotal="${si}" class="${Math.abs(ct - 100) < 0.001 ? 'good' : 'bad'}">${ct}%</b>
                <button class="btn sm ghost ${Math.abs(ct - 100) > 0.001 ? '' : 'hidden'}" data-even="${si}">Split evenly</button></span></div>
            </div></div>`;
        }).join('')}
        <p class="muted small">Changing the plan only affects future incomes. Past incomes keep the split they were saved with, so your history stays accurate.</p>`;
    },

    goals() {
      const goals = L.goalTimelines(state, goalExtras);
      const debts = L.currentDebts(state);
      const inc = L.avgMonthlyIncome(state, 3);
      const debtPct = L.sum(state.sections.filter((x) => x.type === 'debt'), (x) => x.percent);
      if (debtBudget == null) debtBudget = L.round2(inc * debtPct / 100);
      const plan = L.debtPlan(debts, debtBudget, debtStrategy);
      const other = L.debtPlan(debts, debtBudget, debtStrategy === 'avalanche' ? 'snowball' : 'avalanche');
      const thisMonth = L.monthKey(today());
      return `<h1>Goals & debts</h1><p class="sub">When you'll reach each goal, and the fastest way to become debt-free.</p>
        <div class="card"><h2>Savings goals</h2>
          ${inc ? `<p class="muted small" style="margin-top:0">Based on your average income of <b>${m(inc)}</b>/month over your last 3 months of income and your split plan. Drag a slider to see what saving extra each month does.</p>` : `<p class="muted small" style="margin-top:0">Log some income first so the app can estimate how fast your goals fill up.</p>`}
          ${goals.length ? goals.map((g) => `<div class="goal" data-goal="${g.categoryId}" style="--c:${g.color}">
            <div class="row between"><div><b>${esc(g.name)}</b> <span class="muted small">${esc(g.section)}</span></div><div><b>${m(g.saved)}</b> <span class="muted">of ${m(g.target)}</span></div></div>
            <div class="bar mt-s"><i style="width:${g.pct}%;background:${g.color}"></i></div>
            <div class="row between mt-s wrap small">
              <span class="muted">Plan adds <b>${m(g.planRate)}</b>/month${g.extra ? ` + <b class="g-extra-v">${m(g.extra)}</b> extra` : ''}</span>
              <span class="g-eta">${g.left <= 0 ? '<b class="good">Goal reached 🎉</b>' : g.months == null ? '<span class="warn">Not growing yet — give it a share in your plan</span>' : `<b>${g.months}</b> month${g.months === 1 ? '' : 's'} left · <b>${L.monthLabel(g.eta)}</b>`}</span>
            </div>
            ${g.left > 0 ? `<label class="slider-row small muted">Extra per month <input type="range" min="0" max="${Math.max(200, Math.ceil(g.left / 100) * 10)}" step="10" value="${g.extra}" data-extra="${g.categoryId}"><span class="g-extra-label">${m(g.extra)}</span></label>` : ''}
          </div>`).join('') : `<div class="empty">No goals yet. In <a href="#" data-go="plan">Split plan</a>, give a savings category a <b>Goal</b> amount (e.g. Wedding $10,000).</div>`}
        </div>

        <div class="card mt"><h2>Debt payoff planner</h2>
          ${debts.length ? `
          <div class="row wrap">
            <label class="f" style="min-width:200px">Paying towards debts each month<div class="money-input" data-sym="${sym()}"><input id="dbBudget" type="text" inputmode="decimal" autocomplete="off" min="0" step="10" value="${debtBudget}"></div></label>
            <div class="tabs" style="margin:18px 0 0"><button data-strat="avalanche" class="${debtStrategy === 'avalanche' ? 'active' : ''}">Avalanche · highest interest first</button><button data-strat="snowball" class="${debtStrategy === 'snowball' ? 'active' : ''}">Snowball · smallest first</button></div>
          </div>
          ${debts.some((d) => !d.apr) ? `<p class="small warn">Tip: add each debt's interest rate and minimum payment in Split plan for an accurate plan.</p>` : ''}
          ${!plan.ok ? `<div class="result-card card mt bad">At ${m(debtBudget)}/month the debts ${plan.reason === 'no-budget' ? "won't go down — set an amount above" : 'grow faster than you pay them. Increase the monthly amount'}.</div>` : `
          <div class="grid g3 mt">
            <div class="card stat"><div class="label">Debt-free in</div><div class="value">${plan.months} mo</div><div class="muted small mt-s">${L.monthLabel(L.addMonths(thisMonth, plan.months))}</div></div>
            <div class="card stat"><div class="label">Interest you'll pay</div><div class="value">${m(plan.totalInterest)}</div>${other.ok && other.totalInterest !== plan.totalInterest ? `<div class="muted small mt-s">${other.totalInterest > plan.totalInterest ? 'Saves' : 'Costs'} ${m(Math.abs(other.totalInterest - plan.totalInterest))} vs ${debtStrategy === 'avalanche' ? 'snowball' : 'avalanche'}</div>` : ''}</div>
            <div class="card stat"><div class="label">Still owed</div><div class="value">${m(L.sum(debts, (d) => d.balance))}</div><div class="muted small mt-s">${debts.length} debt${debts.length === 1 ? '' : 's'}</div></div>
          </div>
          ${plan.underMin ? `<p class="small warn">That's below your minimum payments (${m(plan.minTotal)}/month).</p>` : ''}
          <table class="mt"><thead><tr><th>Order</th><th>Debt</th><th class="num">Owed</th><th class="num">Interest</th><th class="num">Paid off</th></tr></thead><tbody>
          ${plan.debts.slice().sort((a, b) => a.paidOffMonth - b.paidOffMonth).map((d, i) => { const src = debts.find((x) => x.name === d.name);
            return `<tr><td>${i + 1}</td><td>${esc(d.name)}${d.apr ? ` <span class="muted small">${d.apr}%/yr</span>` : ''}</td><td class="num">${m(src ? src.balance : 0)}</td><td class="num">${m(d.interest)}</td><td class="num"><b>${L.monthLabel(L.addMonths(thisMonth, d.paidOffMonth))}</b></td></tr>`; }).join('')}
          </tbody></table>`}` : `<div class="empty">No debts with a total. In <a href="#" data-go="plan">Split plan</a>, set a <b>Total owed</b> on your debt categories.</div>`}
        </div>`;
    },

    reports() {
      const series = L.monthlySeries(state, reportRange || null);
      const from = series[0].month + '-01';
      const totIn = L.round2(L.sum(series, (r) => r.income)), totOut = L.round2(L.sum(series, (r) => r.out));
      const byType = {}; series.forEach((r) => Object.entries(r.byType).forEach(([k, v]) => { byType[k] = (byType[k] || 0) + v; }));
      const cats = L.spendingByCategory(state, from);
      const catMax = Math.max(1, ...cats.map((c) => c.amount));
      const lastMonth = L.addMonths(L.monthKey(today()), -1);
      const reports = state.monthlyReports.slice().sort((a, b) => b.month.localeCompare(a.month));
      return `<div class="row between"><div><h1>Reports</h1><p class="sub">Where your money came from and where it went.</p></div>
          <div class="row wrap"><button class="btn" id="rpCsv">⬇ Export to Excel (CSV)</button><button class="btn primary" id="rpPrint">📄 Export PDF report</button></div></div>
        <div class="tabs">${[[3, '3 months'], [6, '6 months'], [12, '12 months'], [0, 'All time']].map(([k, l]) => `<button data-range="${k}" class="${reportRange === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="grid g3">
          <div class="card stat"><div class="label">Income</div><div class="value good" data-count="${totIn}">${m(totIn)}</div><div class="muted small mt-s">${series.length} month${series.length === 1 ? '' : 's'}</div></div>
          <div class="card stat"><div class="label">Money out</div><div class="value" data-count="${totOut}">${m(totOut)}</div><div class="muted small mt-s">spent, paid & invested</div></div>
          <div class="card stat"><div class="label">Kept</div><div class="value ${totIn - totOut < 0 ? 'bad' : ''}">${totIn ? Math.round((totIn - totOut) / totIn * 100) : 0}%</div><div class="muted small mt-s">of income · ${m(totIn - totOut)} still in your buckets</div></div>
        </div>
        <div class="grid g2 mt">
          <div class="card"><div class="row between"><h2>Income vs money out</h2><div class="legend" style="margin:0"><span><b class="lg-in"></b>Income</span><span><b class="lg-out"></b>Out</span></div></div>${barChart(series)}</div>
          <div class="card"><h2>Balance over time</h2>${lineChart(series)}<p class="muted small" style="margin:6px 0 0">Total money left across all your buckets at the end of each month.</p></div>
        </div>
        <div class="grid g2 mt">
          <div class="card"><h2>Top spending</h2>${cats.length ? cats.slice(0, 10).map((c) => `<div class="hbar"><div class="row between small"><span>${esc(c.name)} <span class="muted">${esc(c.section)}</span></span><b>${m(c.amount)}</b></div><div class="bar"><i style="width:${(c.amount / catMax) * 100}%;background:${c.color}"></i></div></div>`).join('') : '<div class="empty">No spending in this period.</div>'}</div>
          <div class="card"><h2>By type</h2>${Object.keys(byType).length ? Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="hbar"><div class="row between small"><span>${L.SECTION_TYPES[k] ? L.SECTION_TYPES[k].label : k}</span><b>${m(v)} <span class="muted">${totOut ? Math.round(v / totOut * 100) : 0}%</span></b></div><div class="bar"><i style="width:${totOut ? v / totOut * 100 : 0}%"></i></div></div>`).join('') : '<div class="empty">Nothing yet.</div>'}</div>
        </div>
        <div class="card advice-card mt"><div class="row between"><h2>✦ Monthly AI report</h2><button class="btn sm primary" id="rpAi" ${aiBusy ? 'disabled' : ''}>${aiBusy ? 'Writing…' : `Write report for ${L.monthLabel(lastMonth)}`}</button></div>
          ${reports.length ? reports.slice(0, 6).map((r) => `<details ${r === reports[0] ? 'open' : ''}><summary><b>${L.monthLabel(r.month)}</b> <span class="muted small">written ${fmtDate(r.date)}</span></summary><div class="advice md mt-s">${md(r.text)}</div></details>`).join('') : '<p class="muted small">Get a short review of last month: what went well, what didn’t, and three things to change.</p>'}
        </div>`;
    },

    history() {
      const rows = activity().filter((r) => historyFilter === 'all' || r.kind === historyFilter);
      return `<h1>History</h1><p class="sub">Every income, payment and transfer. Click ✎ to edit or ✕ to delete.</p>
        <div class="tabs">${[['all', 'All'], ['income', 'Income'], ['spend', 'Spending & payments'], ['transfer', 'Transfers']].map(([k, l]) => `<button data-filter="${k}" class="${historyFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="card">${rows.length ? activityTable(rows, true) : '<div class="empty">Nothing here yet.</div>'}</div>`;
    },

    advisor() {
      const s = state.settings;
      const noKey = !s.aiEnabled || (!s.apiKey && !apiBase);
      return `<h1>AI advisor</h1><p class="sub">Ask anything about your money. The advisor sees your plan, balances, debts, goals and recent activity.</p>
        ${noKey ? `<div class="card mt" style="border-color:rgba(242,180,91,.4)"><b class="warn">AI is off.</b> <span class="muted">${s.aiEnabled ? 'Connect to the internet to use the AI advisor.' : 'Turn on the AI advisor in Settings.'} Until then you'll get offline tips.</span> <button class="btn sm" data-go="settings">Open Settings</button></div>` : ''}
        <div class="card mt"><div class="chat" id="chat">
          ${state.chat.length ? state.chat.map((c) => c.role === 'user' ? `<div class="msg user">${esc(c.content)}</div>` : `<div class="msg assistant">${avatar()}<div class="md">${md(c.content)}</div></div>`).join('') : `<div class="empty">Try: “How long until I can pay off my debts?” · “Should I move more to my wedding fund?” · “Review my spending this month.”</div>`}
          ${aiBusy ? `<div class="msg assistant">${avatar()}<div class="typing">Thinking…</div></div>` : ''}
        </div>
        <div class="chat-row mt"><input id="chatInput" placeholder="Ask the advisor…" ${aiBusy ? 'disabled' : ''}><button class="btn primary" id="chatSend" ${aiBusy ? 'disabled' : ''}>Send</button>
          ${state.chat.length ? '<button class="btn ghost" id="chatClear" title="Clear chat">Clear</button>' : ''}</div></div>`;
    },

    settings() {
      const s = state.settings;
      const acc = root.account, meta = root.meta[root.active];
      const shared = Object.keys(root.books).filter((k) => k !== 'local');
      return `<h1>Settings</h1><p class="sub">${acc ? 'Saved on this device and synced to your account.' : 'Everything is stored only on this device.'}</p>
        <div class="card account-card"><div class="row between wrap"><h2 style="margin:0">Account & sync</h2>${acc ? `<span class="muted small">Signed in as <b>${esc(acc.username)}</b> · <a href="#" id="accOut">Log out</a></span>` : ''}</div>
          ${!apiBase ? '<p class="muted small">The online service isn’t reachable right now. Check your internet connection.</p>' : !acc ? `
            <p class="muted small">Create a free account to sync this budget between your phone and computer, share a budget with someone, and get more daily AI requests.</p>
            <div class="form-grid acc-form"><label class="f">Username<input id="accUser" autocomplete="username" placeholder="e.g. leon"></label><label class="f">Password<input id="accPass" type="password" autocomplete="current-password" placeholder="8+ characters"></label></div>
            <div class="row mt-s"><button class="btn primary" id="accLogin">Log in</button><button class="btn" id="accSignup">Create account</button></div>
            <p class="muted small">Your budget is stored on the server so your devices can sync. Your PIN and any personal API key never leave this device.</p>` : `
            <div class="grid g2 mt-s">
              <div><b>This budget: ${esc(meta.name || 'My budget')}</b>
                <p class="muted small" style="margin:4px 0 10px">${meta.remoteId ? (meta.shared ? 'Shared — everyone in it sees the same buckets and entries.' : 'Syncing between your devices.') : 'Only on this device.'}</p>
                ${meta.shared && meta.members ? `<div class="members mb">${meta.members.map((u) => `<span class="avatar">${esc(u.charAt(0).toUpperCase())}</span>`).join('')}<span class="small">${meta.members.map(nice).map(esc).join(', ')}</span></div>` : ''}
                ${!meta.remoteId ? '<button class="btn primary" id="syncOn">Turn on sync</button>' : `<button class="btn" id="syncNow">Sync now</button> ${meta.shared || root.active !== 'local' ? '<button class="btn" id="bookInvite">Invite someone</button>' : ''}`}
                ${root.active !== 'local' ? '<button class="btn ghost danger" id="bookLeave">Leave this budget</button>' : ''}
              </div>
              <div><b>Shared budgets</b>
                <p class="muted small" style="margin:4px 0 10px">Plan money together, e.g. a wedding or household budget. Each person logs their own spending; everyone sees the totals.</p>
                <div class="row wrap"><button class="btn" id="bookNew">＋ New shared budget</button><input id="joinCode" placeholder="Invite code" style="width:130px;text-transform:uppercase"><button class="btn" id="bookJoin">Join</button></div>
                ${remoteBooks ? remoteBooks.filter((b) => !Object.values(root.meta).some((mm) => mm.remoteId === b.id)).map((b) => `<div class="row between mt-s small"><span>${esc(b.name)} <span class="muted">${b.shared ? b.members + ' people' : 'your budget'}</span></span><button class="btn sm" data-getbook="${b.id}">Use on this device</button></div>`).join('') : ''}
              </div>
            </div>
            ${Object.keys(root.books).length > 1 ? `<div class="mt-s small muted">Switch between budgets from the menu at the top of the sidebar.</div>` : ''}`}
        </div>
        <div class="settings-cols">
          <div class="card"><h2>General</h2>
              <div class="form-grid">
                <label class="f full">Your name (the advisor uses it)<input id="sName" value="${esc(s.userName || '')}" placeholder="Optional"></label>
                <label class="f">Currency code<input id="sCur" value="${esc(s.currency)}"></label>
                <label class="f">Currency symbol<input id="sSym" value="${esc(s.currencySymbol)}"></label>
                <label class="f full">Lebanese lira rate (LBP per $1)<input id="sRate" type="text" inputmode="numeric" autocomplete="off" value="${s.lbpRate}"></label>
              </div>
              <button class="btn primary mt" id="sSave">Save settings</button>
          </div>
          <div class="card"><h2>AI advisor</h2>
            <label class="row small"><input type="checkbox" id="sAi" ${s.aiEnabled ? 'checked' : ''}> Enable AI advisor</label>
            <label class="row small mt-s"><input type="checkbox" id="sAuto" ${s.autoAdviceOnIncome ? 'checked' : ''}> Give advice automatically every time I log income</label>
            <p class="small muted">The AI is built in — no key needed (${root.account ? '30' : '10'} requests a day${root.account ? '' : '; 30 with a free account'}).</p>
            <details><summary class="small">Advanced: use my own Anthropic API key</summary>
            <label class="f mt">Anthropic API key (optional)<input id="sKey" type="password" value="${esc(s.apiKey)}" placeholder="Leave empty to use the built-in AI"></label>
            <div class="small muted mt-s">With your own key there's no daily limit; you pay Anthropic directly. It stays on this device.</div></details>
            <label class="f mt">Model<input id="sModel" value="${esc(s.model)}"></label>
            <label class="f mt">About me (the advisor uses this for context)<textarea id="sAbout" rows="4" placeholder="e.g. saving for a wedding next summer, paying off a car loan">${esc(s.aboutMe)}</textarea></label>
            <p class="small muted" style="margin-bottom:0">AI settings are saved with <b>Save settings</b>.</p>
          </div>
            <div class="card"><h2>Theme</h2>
              <div class="themes">${[['black', 'Black'], ['navy', 'Navy'], ['pink', 'Pink'], ['light', 'Light']].map(([k, l]) => `<button class="theme-swatch ${s.theme === k ? 'active' : ''}" data-theme-pick="${k}"><span class="sw sw-${k}"></span>${l}</button>`).join('')}</div>
            </div>
            <div class="card"><h2>Wallets</h2>
              <p class="muted small" style="margin-top:0">Where your money physically is — cash, cards, bank. Starting balance = what was in it before you started using the app.</p>
              ${s.wallets.map((w, i) => `<div class="wallet-edit"><input value="${esc(w.name)}" data-wname="${i}" placeholder="Wallet name"><div class="money-input" data-sym="${sym()}"><input type="text" inputmode="decimal" autocomplete="off" step="0.01" value="${w.opening || 0}" data-wopen="${i}" title="Starting balance"></div><button class="icon-btn" data-wdel="${i}" title="Delete wallet">✕</button></div>`).join('')}
              <div class="row mt-s"><button class="btn sm" id="wAdd">＋ Add wallet</button><button class="btn sm primary" id="wSave">Save wallets</button></div>
            </div>
            <div class="card"><h2>App lock</h2>
              <p class="muted small" style="margin-top:0">${s.pinHash ? 'A PIN is required when the app opens.' : 'Ask for a 4-digit PIN every time the app opens.'}</p>
              <div class="row">${s.pinHash ? '<button class="btn" id="pinChange">Change PIN</button><button class="btn ghost danger" id="pinOff">Turn off</button>' : '<button class="btn" id="pinOn">Set a PIN</button>'}</div>
            </div>
            <div class="card"><h2>Backup</h2>
              <p class="muted small" style="margin-top:0">${root.account ? 'Your budget is saved on this device and synced to your account.' : 'Your data is stored only on this device and survives updates.'} Export a backup now and then anyway.</p>
              <div class="row wrap"><button class="btn" id="bExport">Export backup</button><button class="btn" id="bImport">Import backup</button><button class="btn ghost" id="bFolder">Open data folder</button></div>
              <button class="btn danger ghost mt" id="bReset">Reset everything…</button>
            </div>
            <div class="card"><h2>Updates</h2>
              <p class="muted small" style="margin-top:0" id="updText">Version <span id="verText"></span>. ${api.platform === 'web' ? 'The app updates itself automatically whenever you open it online.' : 'The app checks for updates automatically on launch.'}</p>
              <button class="btn" id="uCheck">Check for updates</button>
            </div>
        </div>`;
    }
  };

  // ---------------- Page fragments ----------------
  function sectionCard(s) {
    const type = L.SECTION_TYPES[s.type];
    return `<div class="card section-card" style="--c:${s.color}">
      <div class="section-head"><div><span class="name">${esc(s.name)}</span><span class="tag">${type.label} · ${s.percent}%</span></div>
        <div class="${s.available < 0 ? 'bad' : ''}" style="font-weight:700;font-size:16px">${m(s.available)}</div></div>
      ${s.categories.map((c) => {
        let extra = '', barPct = c.allocated + c.transferIn > 0 ? Math.max(0, Math.min(100, (c.available / (c.allocated + c.transferIn)) * 100)) : 0;
        if (c.progress && c.progress.kind === 'debt') { extra = `Paid ${m(c.progress.done)} of ${m(c.progress.target)} · <b>${m(c.progress.remaining)} still owed</b>`; barPct = c.progress.pct; }
        else if (c.progress) { extra = `${Math.round(c.progress.pct)}% of ${m(c.progress.target)} goal`; barPct = c.progress.pct; }
        else if (c.spent) extra = `${type.past} ${m(c.spent)} of ${m(c.allocated + c.transferIn - c.transferOut)}`;
        return `<div class="cat-row"><div>${esc(c.name)} <span class="muted small">${c.percent}%</span>${extra ? `<div class="muted small">${extra}</div>` : ''}</div>
          <div class="amt ${c.available < 0 ? 'bad' : ''}">${m(c.available)}<div class="muted small" style="font-weight:400">available</div></div>
          <div class="bar"><i style="width:${barPct}%"></i></div></div>`;
      }).join('')}</div>`;
  }

  function activity() {
    const name = (sid, cid) => { const { section, category } = L.findCategory(state, sid, cid); return section ? `${section.name} → ${category ? category.name : '?'}` : '(deleted category)'; };
    const rows = [];
    state.incomes.forEach((i) => rows.push({ kind: 'income', id: i.id, at: i.createdAt || 0, date: i.date, amount: i.amount, what: i.source || 'Income', note: i.note, detail: ['Into ' + walletName(i.walletId), i.original ? lbp(i.original.amount) : '', byTag(i)].filter(Boolean).join(' · ') }));
    state.transactions.forEach((t) => rows.push({ kind: 'spend', id: t.id, at: t.createdAt || 0, date: t.date, amount: -t.amount, what: name(t.sectionId, t.categoryId), note: t.note, detail: [walletName(t.walletId), t.original ? lbp(t.original.amount) : '', byTag(t)].filter(Boolean).join(' · ') }));
    state.walletTransfers.forEach((t) => rows.push({ kind: 'transfer', id: t.id, at: t.createdAt || 0, date: t.date, amount: t.amount, what: `${walletName(t.fromWalletId)}  ⇢  ${walletName(t.toWalletId)}`, note: t.note, detail: ['Wallet move', byTag(t)].filter(Boolean).join(' · '), wallet: true }));
    state.transfers.forEach((t) => rows.push({ kind: 'transfer', id: t.id, at: t.createdAt || 0, date: t.date, amount: t.amount, what: `${name(t.from.sectionId, t.from.categoryId)}  ⇢  ${name(t.to.sectionId, t.to.categoryId)}`, note: t.note, detail: byTag(t) }));
    return rows.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);
  }

  function activityTable(rows, editable) {
    const pill = { income: '<span class="pill in">Income</span>', spend: '<span class="pill out">Paid</span>', transfer: '<span class="pill tr">Moved</span>' };
    return `<table><thead><tr><th>Date</th><th>Type</th><th>What</th><th>Note</th><th class="num">Amount</th>${editable ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="muted">${fmtDate(r.date)}</td><td>${pill[r.kind]}</td><td>${esc(r.what)}${r.detail ? `<div class="muted small">${esc(r.detail)}</div>` : ''}</td>
        <td class="muted">${esc(r.note || '')}</td><td class="num ${r.kind === 'income' ? 'good' : r.kind === 'spend' ? 'bad' : ''}">${r.kind === 'income' ? '+' : ''}${m(r.amount)}</td>
        ${editable ? `<td class="num" style="white-space:nowrap">${r.wallet ? '' : `<button class="icon-btn" data-edit="${r.kind}|${r.id}" title="Edit">✎</button>`}<button class="icon-btn" data-del="${r.wallet ? 'wtransfer' : r.kind}|${r.id}" title="Delete">✕</button></td>` : ''}</tr>`).join('')}
    </tbody></table>`;
  }

  function incomeOverrides() {
    if (!$('#incCustom') || !$('#incCustom').checked) return null;
    const o = {};
    $$('[data-ov]').forEach((el) => { o[el.dataset.ov] = num(el.value); });
    return o;
  }

  function incomePreviewHtml(amount, overrides) {
    const split = L.splitIncome(amount || 0, state.sections, overrides);
    const custom = $('#incCustom') && $('#incCustom').checked;
    const total = L.round2(L.sum(split.sectionAmounts, (x) => x.percent));
    return `${state.sections.map((s, i) => {
      const sa = split.sectionAmounts[i];
      return `<div style="padding:10px 0;border-top:1px solid var(--line)">
        <div class="row between"><div class="row"><b style="width:10px;height:10px;border-radius:3px;background:${s.color};display:inline-block"></b><b>${esc(s.name)}</b>
          ${custom ? `<div class="pct-input" style="width:90px"><input type="text" inputmode="decimal" autocomplete="off" min="0" max="100" step="0.5" data-ov="${s.id}" value="${sa.percent}"></div>` : `<span class="muted small">${sa.percent}%</span>`}</div>
          <b data-secamt="${s.id}">${m(sa.amount)}</b></div>
        <div class="muted small mt-s" data-seccats="${s.id}">${s.categories.map((c) => { const a = split.allocations.find((x) => x.categoryId === c.id); return `${esc(c.name)} ${m(a.amount)}`; }).join(' · ')}</div></div>`;
    }).join('')}
    ${custom ? `<div class="small mt-s">Total: <b id="ovTotal" class="${Math.abs(total - 100) < 0.001 ? 'good' : 'bad'}">${total}%</b></div>` : ''}`;
  }

  function lastIncomeAdviceHtml() {
    const inc = state.incomes.find((i) => i.id === lastIncomeId);
    if (!inc) return '';
    return `<div class="card advice-card mt"><h2>✦ Advisor's take on ${m(inc.amount)}</h2>
      <div class="advice md">${aiBusy && !inc.advice ? '<span class="typing">Thinking about this income…</span>' : md(inc.advice || '')}</div></div>`;
  }

  function spendForm() {
    return `<div class="grid g12"><div class="card">
      <label class="f">Which bucket is this from?<select id="spCat">${categoryOptions(spendForm.last)}</select></label>
      <div id="spAvail" class="small muted mt-s"></div>
      <div class="row between mt"><span class="small muted">Amount</span>
        <button class="btn sm" id="spScan" ${scanBusy ? 'disabled' : ''}>${scanBusy ? 'Reading receipt…' : '📷 Scan receipt'}</button><input type="file" id="spScanFile" accept="image/*" capture="environment" class="hidden"></div>
      <div class="amount-row mt-s"><input class="big" id="spAmount" type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" placeholder="0.00">${currencySelect('spCur')}</div>
      <div class="small muted mt-s" id="spConv"></div>
      <div class="form-grid mt">
        <label class="f">Date<input id="spDate" type="date" value="${today()}"></label>
        <label class="f">Paid from wallet<select id="spWallet">${walletOptions(spendForm.lastWallet)}</select></label>
        <label class="f full">Note<input id="spNote" placeholder="e.g. groceries, March installment"></label>
      </div>
      <button class="btn primary mt" id="spSave" style="width:100%">Save</button>
    </div><div class="card"><h2>Bucket status</h2><div id="spStatus"></div></div></div>`;
  }

  function transferForm() {
    return `<div class="card" style="max-width:640px">
      <div class="form-grid">
        <label class="f">From<select id="trFrom">${categoryOptions()}</select></label>
        <label class="f">To<select id="trTo">${categoryOptions()}</select></label>
        <label class="f">Amount<div class="money-input" data-sym="${sym()}"><input id="trAmount" type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" placeholder="0.00"></div></label>
        <label class="f">Date<input id="trDate" type="date" value="${today()}"></label>
        <label class="f full">Note<input id="trNote" placeholder="Optional"></label>
      </div>
      <button class="btn primary mt" id="trSave">Move money</button></div>`;
  }

  function walletTransferForm() {
    const ws = L.walletBalances(state);
    return `<div class="card" style="max-width:640px">
      <p class="muted small" style="margin-top:0">For example, withdrawing cash from your card. This only moves money between wallets — your buckets don't change.</p>
      <div class="form-grid">
        <label class="f">From<select id="wtFrom">${walletOptions()}</select></label>
        <label class="f">To<select id="wtTo">${walletOptions(state.settings.wallets[1] && state.settings.wallets[1].id)}</select></label>
        <label class="f">Amount<div class="amount-row"><input id="wtAmount" type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" placeholder="0.00">${currencySelect('wtCur')}</div></label>
        <label class="f">Date<input id="wtDate" type="date" value="${today()}"></label>
        <label class="f full">Note<input id="wtNote" placeholder="Optional"></label>
      </div>
      <button class="btn primary mt" id="wtSave">Move money</button>
      <div class="wallets mt">${ws.map((w) => `<div class="wallet"><div class="muted small">${esc(w.name)}</div><div class="w-bal">${m(w.balance)}</div></div>`).join('')}</div></div>`;
  }

  function recurringPanel() {
    const list = state.recurring;
    return `<div class="grid g12"><div class="card"><h2>Add a recurring bill</h2>
      <div class="form-grid">
        <label class="f full">Name<input id="rcName" placeholder="e.g. Rent, Netflix, Car loan"></label>
        <label class="f">Amount<div class="amount-row"><input id="rcAmount" type="text" inputmode="decimal" autocomplete="off" min="0" step="0.01" placeholder="0.00">${currencySelect('rcCur')}</div></label>
        <label class="f">Day of the month<input id="rcDay" type="text" inputmode="numeric" autocomplete="off" min="1" max="28" value="1"></label>
        <label class="f full">From bucket<select id="rcCat">${categoryOptions()}</select></label>
        <label class="f">Paid from wallet<select id="rcWallet">${walletOptions()}</select></label>
        <label class="f">When it's due<select id="rcAuto"><option value="1">Log it automatically</option><option value="0">Remind me, I'll confirm</option></select></label>
      </div>
      <button class="btn primary mt" id="rcSave">Add bill</button></div>
      <div class="card"><h2>Your recurring bills</h2>
      ${list.length ? `<table><thead><tr><th>Bill</th><th>Day</th><th class="num">Amount</th><th></th></tr></thead><tbody>${list.map((r) => {
        const { section, category } = L.findCategory(state, r.sectionId, r.categoryId);
        return `<tr><td>${esc(r.name)}<div class="muted small">${section ? esc(section.name + ' → ' + category.name) : '(deleted bucket)'} · ${esc(walletName(r.walletId))} · ${r.auto ? 'automatic' : 'reminder'}${r.lastLogged === L.monthKey(today()) ? ' · ✓ this month' : ''}</div></td>
          <td>${ord(r.day)}</td><td class="num">${m(r.amount)}</td><td class="num"><button class="icon-btn" data-delrc="${r.id}" title="Delete">✕</button></td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No recurring bills yet.</div>'}
      <p class="muted small">Automatic bills are logged the first time you open the app on or after their day. Reminders show on the dashboard (and as a notification) until you mark them paid.</p></div></div>`;
  }

  function bucketStatus(value) {
    const [sid, cid] = value.split('|');
    const { section, category } = L.findCategory(state, sid, cid);
    const b = L.balances(state).get(sid, cid);
    if (!section || !b) return '';
    let html = `<div class="stat"><div class="label">${esc(section.name)} → ${esc(category.name)}</div><div class="value ${b.available < 0 ? 'bad' : ''}">${m(b.available)}</div><div class="muted small">available to use</div></div>
      <table class="mt"><tr><td class="muted">Allocated from income</td><td class="num">${m(b.allocated)}</td></tr>
      ${b.transferIn || b.transferOut ? `<tr><td class="muted">Moved in / out</td><td class="num">${m(b.transferIn)} / ${m(b.transferOut)}</td></tr>` : ''}
      <tr><td class="muted">${L.SECTION_TYPES[section.type].past} so far</td><td class="num">${m(b.spent)}</td></tr>`;
    if (category.target) {
      html += section.type === 'debt'
        ? `<tr><td class="muted">Total debt</td><td class="num">${m(category.target)}</td></tr><tr><td class="muted">Still owed</td><td class="num bad">${m(Math.max(0, category.target - b.spent))}</td></tr>`
        : `<tr><td class="muted">Goal</td><td class="num">${m(category.target)}</td></tr>`;
    }
    return html + '</table>';
  }

  // ---------------- Render & events ----------------
  // ---------------- Phone navigation: bottom bar + sheets ----------------
  const MORE_PAGES = ['goals', 'plan', 'history', 'settings', 'income', 'spend'];
  function updateMobileBar() {
    $$('[data-mtab]').forEach((b) => b.classList.toggle('active', b.dataset.mtab === page || (b.dataset.mtab === 'more' && ['goals', 'plan', 'history', 'settings'].includes(page))));
  }
  function sheet(title, items, extra) {
    const rootEl = $('#sheetRoot');
    rootEl.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="${esc(title)}"><div class="sheet-grip"></div><div class="sheet-title">${esc(title)}</div>
      ${extra || ''}<div class="sheet-grid">${items.map((it, i) => `<button class="sheet-item" data-si="${i}"><span class="si-icon">${it.icon}</span><span class="si-text"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('')}</div></div></div>`;
    const bg = $('.sheet-bg', rootEl), sh = $('.sheet', rootEl);
    const close = () => { bg.classList.add('closing'); setTimeout(() => { rootEl.innerHTML = ''; }, 220); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    $$('[data-si]', rootEl).forEach((b) => (b.onclick = () => { const it = items[+b.dataset.si]; rootEl.innerHTML = ''; it.run(); }));
    // swipe down to close
    let y0 = null;
    sh.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    sh.addEventListener('touchmove', (e) => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
    sh.addEventListener('touchend', (e) => { const dy = (e.changedTouches[0].clientY - (y0 || 0)); y0 = null; if (dy > 80) close(); else sh.style.transform = ''; });
    return { el: rootEl, close };
  }
  function openAddSheet() {
    sheet('Add', [
      { icon: '＋', label: 'Log income', sub: 'Split a payment into your buckets', run: () => go('income') },
      { icon: '−', label: 'Spend / Pay', sub: 'Groceries, a bill, a debt payment', run: () => { spendTab = 'spend'; go('spend'); } },
      { icon: '📷', label: 'Scan a receipt', sub: 'Photo → amount, date and category', run: () => { spendTab = 'spend'; go('spend'); const f = $('#spScanFile'); if (f) f.click(); } },
      { icon: '⇄', label: 'Move money', sub: 'Between buckets or wallets', run: () => { spendTab = 'transfer'; go('spend'); } },
      { icon: '🔁', label: 'Recurring bill', sub: 'Rent, subscriptions, loans', run: () => { spendTab = 'recurring'; go('spend'); } }
    ]);
  }
  function openMoreSheet() {
    const keys = Object.keys(root.books);
    const switcher = keys.length > 1 ? `<div class="sheet-books">${keys.map((k) => `<button class="book-chip ${k === root.active ? 'active' : ''}" data-book="${k}">${esc(root.meta[k].name || 'Budget')}${root.meta[k].shared ? ' 👥' : ''}</button>`).join('')}</div>` : '';
    const status = root.account ? `<div class="sheet-status small muted">Signed in as <b>${esc(root.account.username)}</b>${syncState.status === 'ok' ? ' · <span class="good">✓ Synced</span>' : syncState.status === 'offline' ? ' · Offline' : ''}</div>` : '';
    const sh = sheet('More', [
      { icon: '◎', label: 'Goals & debts', sub: 'When you’ll reach each goal', run: () => go('goals') },
      { icon: '%', label: 'Split plan', sub: 'Edit sections and percentages', run: () => go('plan') },
      { icon: '☰', label: 'History', sub: 'Every income and payment', run: () => go('history') },
      { icon: '⚙', label: 'Settings', sub: 'Account, sync, wallets, theme', run: () => go('settings') }
    ], status + switcher);
    $$('[data-book]', sh.el).forEach((b) => (b.onclick = () => { sh.el.innerHTML = ''; switchBook(b.dataset.book); }));
  }

  function render() {
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    updateMobileBar();
    const focused = document.activeElement && document.activeElement.id;
    $('#main').innerHTML = pages[page]();
    bind();
    if (focused && $('#' + focused)) $('#' + focused).focus();
  }

  function go(p) {
    if (page === 'plan' && p !== 'plan') draftPlan = null;
    if (p !== 'spend') lastPaymentMsg = null;
    if (p !== 'income') lastIncomeId = null;
    page = p; render(); $('#main').scrollTop = 0;
    animateEntrance();
  }

  function animateEntrance() {
    const main = $('#main');
    main.classList.remove('page-enter'); void main.offsetWidth; main.classList.add('page-enter');
    clearTimeout(animateEntrance.t);
    animateEntrance.t = setTimeout(() => main.classList.remove('page-enter'), 1300);
    $$('[data-count]').forEach(countUp);
  }

  function countUp(el) {
    const target = Number(el.dataset.count) || 0;
    if (!target || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now(), dur = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
      if (!el.isConnected) return;
      el.textContent = m(target * e);
      if (t < 1) requestAnimationFrame(step); else el.textContent = m(target);
    };
    requestAnimationFrame(step);
  }

  function bind() {
    $$('[data-go]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); go(b.dataset.go); }));
    const handlers = { dashboard: bindDashboard, income: bindIncome, spend: bindSpend, plan: bindPlan, goals: bindGoals, reports: bindReports, history: bindHistory, advisor: bindAdvisor, settings: bindSettings };
    handlers[page]();
  }

  function bindDashboard() {
    if ($('#bookSwitch2')) $('#bookSwitch2').onchange = (e) => switchBook(e.target.value);
    $$('[data-paydue]').forEach((b) => (b.onclick = async () => {
      const r = state.recurring.find((x) => x.id === b.dataset.paydue); if (!r) return;
      const tx = L.recurringTx(r, today()); state.transactions.push(tx); r.lastLogged = L.monthKey(today());
      await persist(); toast(L.paymentMessage(state, tx)); render();
    }));
    $$('[data-reask]').forEach((b) => (b.onclick = () => { const inc = state.incomes.find((i) => i.id === b.dataset.reask); if (inc) adviseOnIncome(inc); }));
  }

  function bindIncome() {
    const amt = () => readAmount('#incAmount', '#incCur').usd;
    const refresh = () => {
      const a = readAmount('#incAmount', '#incCur');
      $('#incConv').textContent = a.cur === 'LBP' && a.raw ? `${lbp(a.raw)} = ${m(a.usd)} at ${state.settings.lbpRate.toLocaleString('en-US')} LBP per $1` : '';
      $('#incPreview').innerHTML = incomePreviewHtml(a.usd, incomeOverrides()); bindOverrides();
    };
    // typing in a percentage box only updates the numbers next to it (no redraw = no jumping cursor)
    const bindOverrides = () => $$('[data-ov]').forEach((el) => (el.oninput = () => {
      const o = incomeOverrides(); const split = L.splitIncome(amt(), state.sections, o);
      split.sectionAmounts.forEach((sa) => { const b = $(`[data-secamt="${sa.sectionId}"]`); if (b) b.textContent = m(sa.amount); });
      state.sections.forEach((sec) => { const d = $(`[data-seccats="${sec.id}"]`); if (d) d.textContent = sec.categories.map((c) => `${c.name} ${m(split.allocations.find((x) => x.categoryId === c.id).amount)}`).join(' · '); });
      const total = L.round2(L.sum(Object.values(o))); const t = $('#ovTotal'); if (t) { t.textContent = total + '%'; t.className = Math.abs(total - 100) < 0.001 ? 'good' : 'bad'; }
    }));
    $('#incAmount').oninput = refresh;
    $('#incCur').onchange = refresh;
    $('#incCustom').onchange = refresh;
    $('#incSave').onclick = async () => {
      const amt0 = readAmount('#incAmount', '#incCur');
      const amount = amt0.usd;
      const err = $('#incErr');
      if (!(amount > 0)) { err.textContent = 'Enter an amount greater than zero.'; return; }
      const v = L.validatePlan(state.sections);
      if (!v.ok) { err.innerHTML = 'Your split plan needs fixing first: ' + esc(v.errors[0]); return; }
      const ov = incomeOverrides();
      if (ov) { const t = L.round2(L.sum(Object.values(ov))); if (Math.abs(t - 100) > 0.001) { err.textContent = `Section percentages add up to ${t}% — they need to total 100%.`; return; } }
      const split = L.splitIncome(amount, state.sections, ov);
      const income = { id: L.uid('inc'), createdAt: Date.now(), by: whoAmI(), date: $('#incDate').value || today(), amount, walletId: $('#incWallet').value, original: amt0.original, source: $('#incSource').value.trim(), note: $('#incNote').value.trim(), allocations: split.allocations, advice: '' };
      state.incomes.push(income);
      await persist();
      lastIncomeId = income.id;
      toast(`${m(amount)} logged and split across ${state.sections.length} sections.`);
      if (state.settings.autoAdviceOnIncome) adviseOnIncome(income); else render();
    };
  }

  function bindSpend() {
    $$('[data-tab]').forEach((b) => (b.onclick = () => { spendTab = b.dataset.tab; lastPaymentMsg = null; render(); }));
    if (spendTab === 'spend') {
      const upd = () => { spendForm.last = $('#spCat').value; $('#spStatus').innerHTML = bucketStatus($('#spCat').value); };
      $('#spCat').onchange = upd; upd();
      const conv = () => { const a = readAmount('#spAmount', '#spCur'); $('#spConv').textContent = a.cur === 'LBP' && a.raw ? `${lbp(a.raw)} = ${m(a.usd)}` : ''; };
      $('#spAmount').oninput = conv; $('#spCur').onchange = conv;
      $('#spWallet').onchange = () => { spendForm.lastWallet = $('#spWallet').value; };
      $('#spScan').onclick = () => $('#spScanFile').click();
      $('#spScanFile').onchange = () => { const f = $('#spScanFile').files[0]; if (f) scanReceipt(f); };
      $('#spSave').onclick = async () => {
        const a = readAmount('#spAmount', '#spCur');
        const amount = a.usd;
        if (!(amount > 0)) return toast('Enter an amount greater than zero.', true);
        const [sectionId, categoryId] = $('#spCat').value.split('|');
        const tx = { id: L.uid('tx'), createdAt: Date.now(), by: whoAmI(), date: $('#spDate').value || today(), sectionId, categoryId, amount, original: a.original, walletId: $('#spWallet').value, method: walletName($('#spWallet').value), note: $('#spNote').value.trim() };
        state.transactions.push(tx);
        await persist();
        lastPaymentMsg = L.paymentMessage(state, tx) + (isShared() ? ' Everyone in this budget can see it now.' : '');
        render();
      };
    } else if (spendTab === 'wallet') {
      $('#wtSave').onclick = async () => {
        const a = readAmount('#wtAmount', '#wtCur');
        if (!(a.usd > 0)) return toast('Enter an amount greater than zero.', true);
        if ($('#wtFrom').value === $('#wtTo').value) return toast('Pick two different wallets.', true);
        state.walletTransfers.push({ id: L.uid('wt'), createdAt: Date.now(), by: whoAmI(), date: $('#wtDate').value || today(), fromWalletId: $('#wtFrom').value, toWalletId: $('#wtTo').value, amount: a.usd, original: a.original, note: $('#wtNote').value.trim() });
        await persist();
        lastPaymentMsg = `${m(a.usd)} moved from ${walletName($('#wtFrom').value)} to ${walletName($('#wtTo').value)}.`;
        render();
      };
    } else if (spendTab === 'recurring') {
      $('#rcSave').onclick = async () => {
        const a = readAmount('#rcAmount', '#rcCur');
        const name = $('#rcName').value.trim();
        if (!name) return toast('Give the bill a name.', true);
        if (!(a.usd > 0)) return toast('Enter an amount greater than zero.', true);
        const [sectionId, categoryId] = $('#rcCat').value.split('|');
        const day = Math.min(28, Math.max(1, Math.round(num($('#rcDay').value)) || 1));
        if ($('#rcAuto').value === '0') { try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {} }
        state.recurring.push({ id: L.uid('rc'), name, amount: a.usd, sectionId, categoryId, walletId: $('#rcWallet').value, day, auto: $('#rcAuto').value === '1', lastLogged: Number(today().slice(8, 10)) >= day ? L.monthKey(today()) : '' });
        await persist(); toast(`${name} added — next one on the ${ord(day)}.`); render();
      };
      $$('[data-delrc]').forEach((b) => (b.onclick = async () => {
        if (!(await confirmBox('Delete recurring bill?', 'Past payments stay in History.', 'Delete'))) return;
        markDeleted(b.dataset.delrc); state.recurring = state.recurring.filter((r) => r.id !== b.dataset.delrc); await persist(); render();
      }));
    } else {
      $('#trSave').onclick = async () => {
        const amount = L.round2(num($('#trAmount').value));
        if (!(amount > 0)) return toast('Enter an amount greater than zero.', true);
        if ($('#trFrom').value === $('#trTo').value) return toast('Pick two different buckets.', true);
        const [fs, fc] = $('#trFrom').value.split('|'); const [ts, tc] = $('#trTo').value.split('|');
        state.transfers.push({ id: L.uid('tr'), createdAt: Date.now(), by: whoAmI(), date: $('#trDate').value || today(), from: { sectionId: fs, categoryId: fc }, to: { sectionId: ts, categoryId: tc }, amount, note: $('#trNote').value.trim() });
        await persist();
        const a = L.findCategory(state, fs, fc).category.name, b = L.findCategory(state, ts, tc).category.name;
        lastPaymentMsg = `${m(amount)} moved from ${a} to ${b}.`;
        render();
      };
    }
  }

  function bindPlan() {
    const rerender = () => { const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; };
    $$('[data-k]').forEach((el) => {
      const evt = el.type === 'color' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const s = draftPlan[+el.dataset.s]; const k = el.dataset.k;
        const target = el.dataset.c != null ? s.categories[+el.dataset.c] : s;
        target[k] = ['percent', 'target', 'apr', 'minPayment'].includes(k) ? num(el.value) : el.value;
        if (k === 'color' || k === 'type') rerender();      // a picker changed: safe to redraw
        else if (k === 'percent') updatePlanTotals();      // typing: only update the totals text
      });
    });
    function updatePlanTotals() {
      const v = L.validatePlan(draftPlan);
      const t = $('#planTotal'); t.textContent = v.total + '%'; t.className = Math.abs(v.total - 100) < 0.001 ? 'good' : 'bad';
      $('#planErrors').innerHTML = v.errors.map((e) => `<div>• ${esc(e)}</div>`).join('');
      $('#planSave').disabled = !v.ok;
      draftPlan.forEach((sec, si) => {
        const ct = L.round2(L.sum(sec.categories, (c) => Number(c.percent) || 0));
        const el = $(`[data-cattotal="${si}"]`); if (!el) return;
        el.textContent = ct + '%'; el.className = Math.abs(ct - 100) < 0.001 ? 'good' : 'bad';
        const ev = $(`[data-even="${si}"]`); if (ev) ev.classList.toggle('hidden', Math.abs(ct - 100) < 0.001);
        const card = el.closest('.plan-sec'); if (card) card.style.setProperty('--c', sec.color);
      });
    }

    $('#planAddSec').onclick = () => { draftPlan.push({ id: L.uid('sec'), name: 'New section', type: 'other', percent: 0, color: L.PALETTE[draftPlan.length % L.PALETTE.length], categories: [{ id: L.uid('cat'), name: 'General', percent: 100, target: 0, note: '' }] }); rerender(); };
    $$('[data-addcat]').forEach((b) => (b.onclick = () => { draftPlan[+b.dataset.addcat].categories.push({ id: L.uid('cat'), name: 'New category', percent: 0, target: 0, note: '' }); rerender(); }));
    $$('[data-even]').forEach((b) => (b.onclick = () => {
      const cats = draftPlan[+b.dataset.even].categories; const parts = L.distribute(100, cats.map(() => 1));
      cats.forEach((c, i) => (c.percent = parts[i])); rerender();
    }));
    $$('[data-delcat]').forEach((b) => (b.onclick = async () => {
      const [si, ci] = b.dataset.delcat.split('|').map(Number); const sec = draftPlan[si];
      if (sec.categories.length === 1) return toast('A section needs at least one category — delete the section instead.', true);
      if (hasHistory(sec.id, sec.categories[ci].id) && !(await confirmBox('Delete category?', `"${sec.categories[ci].name}" has history. Its past entries will stay in History but show as a deleted category.`, 'Delete'))) return;
      sec.categories.splice(ci, 1); rerender();
    }));
    $$('[data-delsec]').forEach((b) => (b.onclick = async () => {
      const sec = draftPlan[+b.dataset.delsec];
      if (!(await confirmBox('Delete section?', `Delete "${sec.name}" and all its categories? Past entries stay in History.`, 'Delete'))) return;
      draftPlan.splice(+b.dataset.delsec, 1); rerender();
    }));
    $('#planReset').onclick = () => { draftPlan = null; rerender(); };
    $('#planSave').onclick = async () => {
      draftPlan.forEach((s) => { s.name = s.name.trim() || 'Untitled'; s.categories.forEach((c) => (c.name = c.name.trim() || 'Untitled')); });
      state.sections = JSON.parse(JSON.stringify(draftPlan));
      state.planUpdatedAt = Date.now();
      await persist(); toast('Plan saved. New incomes will use it.'); draftPlan = null; rerender();
    };
  }

  function hasHistory(sid, cid) {
    return state.incomes.some((i) => i.allocations.some((a) => a.categoryId === cid && a.amount)) ||
      state.transactions.some((t) => t.categoryId === cid) || state.transfers.some((t) => t.from.categoryId === cid || t.to.categoryId === cid);
  }

  function bindHistory() {
    $$('[data-filter]').forEach((b) => (b.onclick = () => { historyFilter = b.dataset.filter; render(); }));
    const listOf = { income: 'incomes', spend: 'transactions', transfer: 'transfers', wtransfer: 'walletTransfers' };
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const [kind, id] = b.dataset.del.split('|');
      const msg = kind === 'income' ? 'Deleting an income also removes the money it added to every bucket.' : 'This entry will be removed and the bucket balance restored.';
      if (!(await confirmBox('Delete entry?', msg, 'Delete'))) return;
      markDeleted(id); state[listOf[kind]] = state[listOf[kind]].filter((x) => x.id !== id);
      await persist(); render();
    }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => {
      const [kind, id] = b.dataset.edit.split('|');
      const item = state[listOf[kind]].find((x) => x.id === id);
      modal(`<h2>Edit ${kind === 'spend' ? 'payment' : kind}</h2>
        <div class="form-grid">
          <label class="f">Amount<input id="eAmount" type="text" inputmode="decimal" autocomplete="off" step="0.01" value="${item.amount}"></label>
          <label class="f">Date<input id="eDate" type="date" value="${item.date.slice(0, 10)}"></label>
          ${kind === 'spend' ? `<label class="f full">Bucket<select id="eCat">${categoryOptions(item.sectionId + '|' + item.categoryId)}</select></label>
            <label class="f">Wallet<select id="eWallet">${walletOptions(item.walletId)}</select></label>` : ''}
          ${kind === 'income' ? `<label class="f">Source<input id="eSource" value="${esc(item.source || '')}"></label><label class="f">Wallet<select id="eWallet">${walletOptions(item.walletId)}</select></label>` : ''}
          <label class="f full">Note<input id="eNote" value="${esc(item.note || '')}"></label>
        </div>
        ${kind === 'income' ? '<p class="muted small">Changing the amount re-splits it using the same proportions it was originally split with.</p>' : ''}
        <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
      (el, close) => {
        $('[data-x]', el).onclick = close;
        $('[data-ok]', el).onclick = async () => {
          const amount = L.round2(num($('#eAmount', el).value));
          if (!(amount > 0)) return toast('Amount must be greater than zero.', true);
          if (kind === 'income' && amount !== item.amount) {
            const parts = L.distribute(amount, item.allocations.map((a) => a.amount || 0.0001));
            item.allocations.forEach((a, i) => (a.amount = parts[i]));
          }
          if (amount !== item.amount) item.original = null;
          item.updatedAt = Date.now();
          item.amount = amount; item.date = $('#eDate', el).value || item.date; item.note = $('#eNote', el).value.trim();
          if (kind === 'spend') { const [s, c] = $('#eCat', el).value.split('|'); item.sectionId = s; item.categoryId = c; item.walletId = $('#eWallet', el).value; item.method = walletName(item.walletId); }
          if (kind === 'income') { item.source = $('#eSource', el).value.trim(); item.walletId = $('#eWallet', el).value; }
          await persist(); close(); render(); toast('Saved.');
        };
      });
    }));
  }

  function bindAdvisor() {
    const chat = $('#chat'); if (chat) chat.scrollIntoView({ block: 'end' });
    const send = async () => {
      const text = $('#chatInput').value.trim(); if (!text || aiBusy) return;
      state.chat.push({ role: 'user', content: text, date: new Date().toISOString() });
      aiBusy = true; render();
      const history = state.chat.slice(-12).map((c) => ({ role: c.role, content: c.content }));
      while (history.length && history[0].role !== 'user') history.shift();
      const res = await askAdvisor(history);
      state.chat.push({ role: 'assistant', content: res.text, date: new Date().toISOString() });
      if (state.chat.length > 100) state.chat = state.chat.slice(-100);
      aiBusy = false; await persist(); render(); $('#chatInput') && $('#chatInput').focus();
    };
    $('#chatSend').onclick = send;
    $('#chatInput').onkeydown = (e) => { if (e.key === 'Enter') send(); };
    if ($('#chatClear')) $('#chatClear').onclick = async () => { state.chat = []; await persist(); render(); };
  }

  function bindSettings() {
    api.version().then((v) => { if ($('#verText')) $('#verText').textContent = v; });
    $('#sSave').onclick = async () => {
      const s = state.settings;
      s.aiEnabled = $('#sAi').checked; s.autoAdviceOnIncome = $('#sAuto').checked;
      s.apiKey = $('#sKey').value.trim(); s.model = $('#sModel').value.trim() || 'claude-haiku-5-5';
      s.aboutMe = $('#sAbout').value.trim(); s.currency = $('#sCur').value.trim() || 'USD'; s.currencySymbol = $('#sSym').value || '$';
      s.userName = $('#sName').value.trim(); s.lbpRate = Math.max(1, num($('#sRate').value) || 89500);
      if ($('#sModel').value.trim() !== 'claude-haiku-5-5') s.modelChosen = true;
      state.settingsUpdatedAt = Date.now();
      await persist(); toast('Settings saved.');
    };
    $('#bExport').onclick = async () => { const p = await api.exportData(state); if (p) toast('Backup saved to ' + p); };
    $('#bImport').onclick = async () => {
      const data = await api.importData(); if (!data) return;
      if (!(await confirmBox('Import backup?', 'This replaces all current data with the backup. Your API key is kept.', 'Import'))) return;
      const keep = Object.assign({}, state.settings); const old = state;
      state = L.migrate(data); L.DEVICE_KEYS.forEach((k) => { state.settings[k] = keep[k]; });
      state.deleted = Object.assign({}, old.deleted || {});
      [...old.incomes, ...old.transactions, ...old.transfers, ...old.walletTransfers, ...old.recurring].forEach((x) => { if (![...state.incomes, ...state.transactions, ...state.transfers, ...state.walletTransfers, ...state.recurring].some((y) => y.id === x.id)) state.deleted[x.id] = Date.now(); });
      state.planUpdatedAt = state.settingsUpdatedAt = Date.now(); root.books[root.active] = state;
      await persist(); toast('Backup imported.'); render();
    };
    if (api.platform === 'web') $('#bFolder').classList.add('hidden');
    $('#bFolder').onclick = () => api.openDataFolder();
    $('#bReset').onclick = async () => {
      if (!(await confirmBox('Reset everything?', 'This deletes all incomes, payments and your plan, and restores the default setup. Export a backup first if you might want it back. This cannot be undone.', 'Reset'))) return;
      const keep = Object.assign({}, state.settings); const old = state;
      state = L.defaultState(); L.DEVICE_KEYS.forEach((k) => { state.settings[k] = keep[k]; });
      state.deleted = Object.assign({}, old.deleted || {});
      [...old.incomes, ...old.transactions, ...old.transfers, ...old.walletTransfers, ...old.recurring].forEach((x) => { state.deleted[x.id] = Date.now(); });
      state.planUpdatedAt = state.settingsUpdatedAt = Date.now(); root.books[root.active] = state;
      await persist(); toast('Reset done.'); render();
    };
    $('#uCheck').onclick = () => { manualUpdateCheck = true; api.checkUpdates(); };
    bindAccount();
    $$('[data-theme-pick]').forEach((b) => (b.onclick = async () => { state.settings.theme = b.dataset.themePick; applyTheme(); await persist(); render(); }));
    const readWallets = () => state.settings.wallets.map((w, i) => Object.assign({}, w, { name: ($(`[data-wname="${i}"]`).value || '').trim() || w.name, opening: num($(`[data-wopen="${i}"]`).value) }));
    $('#wAdd').onclick = () => { state.settings.wallets = readWallets(); state.settings.wallets.push({ id: L.uid('w'), name: 'New wallet', opening: 0 }); render(); };
    $('#wSave').onclick = async () => { state.settings.wallets = readWallets(); state.settingsUpdatedAt = Date.now(); await persist(); toast('Wallets saved.'); render(); };
    $$('[data-wdel]').forEach((b) => (b.onclick = async () => {
      const i = +b.dataset.wdel, w = state.settings.wallets[i];
      if (state.settings.wallets.length === 1) return toast('You need at least one wallet.', true);
      const used = state.transactions.some((t) => t.walletId === w.id) || state.incomes.some((t) => t.walletId === w.id);
      if (used && !(await confirmBox('Delete wallet?', `"${w.name}" has history. Its entries will move to "${state.settings.wallets[i === 0 ? 1 : 0].name}".`, 'Delete'))) return;
      const to = state.settings.wallets[i === 0 ? 1 : 0].id;
      state.transactions.forEach((t) => { if (t.walletId === w.id) t.walletId = to; });
      state.incomes.forEach((t) => { if (t.walletId === w.id) t.walletId = to; });
      state.recurring.forEach((t) => { if (t.walletId === w.id) t.walletId = to; });
      state.walletTransfers = state.walletTransfers.filter((t) => t.fromWalletId !== w.id && t.toWalletId !== w.id);
      state.settings.wallets.splice(i, 1); await persist(); render();
    }));
    const setPin = () => pinDialog('Choose a 4-digit PIN', async (pin1) => pinDialog('Type it again', async (pin2) => {
      if (pin1 !== pin2) { toast("PINs didn't match. Try again.", true); return; }
      state.settings.pinHash = await sha(pin1); await persist(); toast('PIN set. Don\'t forget it — it can\'t be recovered.'); render();
    }));
    if ($('#pinOn')) $('#pinOn').onclick = setPin;
    if ($('#pinChange')) $('#pinChange').onclick = setPin;
    if ($('#pinOff')) $('#pinOff').onclick = async () => { state.settings.pinHash = ''; await persist(); toast('PIN turned off.'); render(); };
  }

  // ---------------- Updates ----------------
  api.onUpdate((u) => {
    const pill = $('#updatePill');
    const text = {
      checking: 'Checking for updates…', none: 'You have the latest version.', available: `Update ${u.version} found — downloading…`,
      downloading: `Downloading update… ${u.percent || 0}%`, ready: `Update ${u.version} is ready.`,
      error: 'Update check failed: ' + (u.message || ''), dev: 'Updates work in the installed app.'
    }[u.status] || '';
    // automatic checks stay quiet unless there is actually an update
    const quiet = !manualUpdateCheck && ['none', 'checking', 'error', 'dev'].includes(u.status);
    pill.classList.toggle('hidden', quiet || u.status === 'none' || u.status === 'checking');
    pill.innerHTML = esc(text) + (u.status === 'ready' ? '<button class="btn primary sm" id="uInstall">Restart & update</button>' : '');
    if ($('#uInstall')) $('#uInstall').onclick = () => api.installUpdate();
    if (manualUpdateCheck && ['none', 'error', 'dev'].includes(u.status)) { toast(text, u.status === 'error'); manualUpdateCheck = false; }
    if (u.status === 'none') setTimeout(() => pill.classList.add('hidden'), 10);
  });

  // ---------------- Account, sync & shared budgets ----------------
  async function refreshRemoteBooks() {
    try { const r = await call('GET', '/me'); remoteBooks = r.books; } catch (_) { remoteBooks = null; }
  }
  async function linkRemote(bookInfo, opts) {
    // bring a server budget onto this device
    const remote = await call('GET', '/books/' + bookInfo.id);
    const ownPersonal = !remote.shared && !(opts && opts.asNew);
    const key = ownPersonal ? 'local' : bookInfo.id;
    const localCopy = root.books[key];
    root.books[key] = ownPersonal && localCopy && !L.isEmptyBudget(localCopy) ? L.mergeStates(localCopy, remote.data, { preferRemote: true }) : L.migrate(remote.data);
    root.meta[key] = { name: remote.name, remoteId: remote.id, rev: remote.rev, shared: !!remote.shared };
    await switchBook(key);
  }
  function bindAccount() {
    const busy = (b, on) => { if (b) { b.disabled = on; } };
    const doAuth = async (path, btn) => {
      const username = $('#accUser').value.trim(), password = $('#accPass').value;
      busy(btn, true);
      try {
        const r = await call('POST', path, { username, password });
        root.account = { token: r.token, username: r.user.username, id: r.user.id };
        await api.save(root);
        await refreshRemoteBooks();
        // a personal budget already on the server (logging in on a second device)?
        const mine = (remoteBooks || []).find((b) => !b.shared && b.role === 'owner');
        if (mine && !root.meta.local.remoteId) {
          if (await confirmBox('Use your synced budget?', L.isEmptyBudget(root.books.local) ? 'Your budget from your other device will be downloaded here.' : 'Your budget from your other device will be combined with what is on this device.', 'Yes, sync it')) await linkRemote(mine);
        }
        toast(path === '/auth/signup' ? 'Account created — welcome!' : 'Logged in.');
        render();
      } catch (e) { toast(e.message, true); busy(btn, false); }
    };
    if ($('#accLogin')) $('#accLogin').onclick = (e) => doAuth('/auth/login', e.currentTarget);
    if ($('#accSignup')) $('#accSignup').onclick = (e) => doAuth('/auth/signup', e.currentTarget);
    if ($('#accOut')) $('#accOut').onclick = async (e) => {
      e.preventDefault();
      if (!(await confirmBox('Log out?', 'Your budgets stay on this device. Shared budgets will stop syncing until you log in again.', 'Log out'))) return;
      try { await call('POST', '/auth/logout'); } catch (_) {}
      root.account = null; remoteBooks = null; await api.save(root); syncState.status = 'off'; drawSync(); render();
    };
    if ($('#syncOn')) $('#syncOn').onclick = async (e) => {
      busy(e.currentTarget, true);
      try {
        const meta = root.meta[root.active];
        const r = await call('POST', '/books', { name: meta.name || 'My budget', shared: false, data: L.forUpload(state) });
        Object.assign(meta, { remoteId: r.id, rev: r.rev });
        await persist({ noSync: true }); toast('Sync is on. Log in on your other devices with the same account.'); syncActive(); render();
      } catch (err2) { toast(err2.message, true); busy(e.currentTarget, false); }
    };
    if ($('#syncNow')) $('#syncNow').onclick = async () => { await syncActive(); toast(syncState.status === 'ok' ? 'All synced.' : syncState.msg || 'Could not sync right now.', syncState.status !== 'ok'); };
    if ($('#bookInvite')) $('#bookInvite').onclick = async () => {
      try {
        const meta = root.meta[root.active];
        const r = await call('POST', '/books/' + meta.remoteId + '/invite');
        meta.shared = true; await persist({ noSync: true }); drawSync();
        modal(`<h2>Invite to “${esc(meta.name)}”</h2><p class="muted">Ask them to open Leon's Ledger → Settings → Account & sync, create an account, and enter this code under <b>Shared budgets</b>:</p>
          <div class="invite-code">${r.code}</div><p class="muted small">The code works for 7 days.</p><div class="row" style="justify-content:flex-end"><button class="btn primary" data-x>Done</button></div>`, (el, close) => { $('[data-x]', el).onclick = close; });
      } catch (e) { toast(e.message, true); }
    };
    if ($('#bookNew')) $('#bookNew').onclick = () => {
      modal(`<h2>New shared budget</h2><label class="f">Name<input id="nbName" placeholder="e.g. Wedding, Home"></label>
        <p class="muted small">It starts with the default split plan — adjust it in Split plan. Then invite the other person.</p>
        <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Create</button></div>`, (el, close) => {
        $('[data-x]', el).onclick = close;
        $('[data-ok]', el).onclick = async () => {
          const name = $('#nbName', el).value.trim() || 'Shared budget';
          try {
            const fresh = L.defaultState(); fresh.settings.wallets = JSON.parse(JSON.stringify(state.settings.wallets)).map((w) => Object.assign(w, { opening: 0 }));
            fresh.settings.currency = state.settings.currency; fresh.settings.currencySymbol = state.settings.currencySymbol; fresh.settings.lbpRate = state.settings.lbpRate;
            fresh.planUpdatedAt = fresh.settingsUpdatedAt = Date.now();
            const r = await call('POST', '/books', { name, shared: true, data: L.forUpload(fresh) });
            root.books[r.id] = fresh; root.meta[r.id] = { name, remoteId: r.id, rev: r.rev, shared: true };
            close(); await switchBook(r.id); go('settings'); toast(`“${name}” created. Tap “Invite someone” to share it.`);
          } catch (e) { toast(e.message, true); }
        };
      });
    };
    if ($('#bookJoin')) $('#bookJoin').onclick = async () => {
      const code = $('#joinCode').value.trim().toUpperCase(); if (!code) return;
      try { const b = await call('POST', '/join', { code }); await linkRemote(b, { asNew: true }); toast(`You joined “${b.name}”.`); go('dashboard'); }
      catch (e) { toast(e.message, true); }
    };
    if ($('#bookLeave')) $('#bookLeave').onclick = async () => {
      const key = root.active, meta = root.meta[key];
      if (!(await confirmBox('Leave this budget?', `“${meta.name}” will be removed from this device and you'll stop seeing it. Others keep it.`, 'Leave'))) return;
      try { await call('POST', '/books/' + meta.remoteId + '/leave'); } catch (_) {}
      delete root.books[key]; delete root.meta[key]; await switchBook('local'); go('dashboard');
    };
    $$('[data-getbook]').forEach((b) => (b.onclick = async () => {
      const info = remoteBooks.find((x) => x.id === b.dataset.getbook);
      try { await linkRemote(info, { asNew: !!info.shared || !!root.meta.local.remoteId }); toast(`“${info.name}” is now on this device.`); }
      catch (e) { toast(e.message, true); }
    }));
    if (root.account && remoteBooks == null) refreshRemoteBooks().then(() => { if (page === 'settings' && remoteBooks && remoteBooks.length) render(); });
  }

  function bindGoals() {
    $$('[data-extra]').forEach((el) => (el.oninput = () => {
      const id = el.dataset.extra; goalExtras[id] = Number(el.value) || 0;
      const g = L.goalTimelines(state, goalExtras).find((x) => x.categoryId === id); const box = el.closest('.goal');
      $('.g-extra-label', box).textContent = m(g.extra);
      $('.g-eta', box).innerHTML = g.left <= 0 ? '<b class="good">Goal reached 🎉</b>' : g.months == null ? '<span class="warn">Not growing yet</span>' : `<b>${g.months}</b> month${g.months === 1 ? '' : 's'} left · <b>${L.monthLabel(g.eta)}</b>`;
    }));
    $$('[data-extra]').forEach((el) => (el.onchange = () => { const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; }));
    if ($('#dbBudget')) $('#dbBudget').onchange = () => { debtBudget = Math.max(0, num($('#dbBudget').value)); const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; };
    $$('[data-strat]').forEach((b) => (b.onclick = () => { debtStrategy = b.dataset.strat; const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; }));
  }

  function bindReports() {
    $$('[data-range]').forEach((b) => (b.onclick = () => { reportRange = Number(b.dataset.range); render(); animateEntrance(); }));
    $('#rpCsv').onclick = async () => {
      const csv = L.toCSV(state), name = `leons-ledger-${today()}.csv`;
      if (api.exportCSV) { const p = await api.exportCSV(name, csv); if (p) toast('Saved to ' + p); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    };
    $('#rpPrint').onclick = async () => {
      const html = window.LedgerReport.build(state, L, { months: reportRange, logoSvg: $('.brand .logo').innerHTML });
      const name = `Leons-Ledger-report-${today()}.pdf`;
      if (api.exportPDF) { toast('Creating your PDF…'); const p = await api.exportPDF(html, name); if (p) toast('PDF saved to ' + p); return; }
      // phone / browser: print the designed report (choose "Save as PDF")
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      f.onload = () => { setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); }, 300); };
      f.srcdoc = html;
    };
    $('#rpAi').onclick = async () => {
      const month = L.addMonths(L.monthKey(today()), -1);
      const r = L.monthlySeries(state, 2)[0];
      const cats = L.spendingByCategory(state, month + '-01', month + '-31').slice(0, 8).map((c) => `${c.name} (${c.section}) ${m(c.amount)}`).join('; ');
      aiBusy = true; render();
      const res = await askAdvisor([{ role: 'user', content: `Write my monthly money report for ${L.monthLabel(month)}. That month: income ${m(r.income)}, money out ${m(r.out)}, net ${m(r.net)}. Top spending: ${cats || 'none logged'}. Structure it as: a one-line summary, what went well, what didn't, and exactly three specific things to do this month. Keep it short.` }]);
      state.monthlyReports = state.monthlyReports.filter((x) => x.month !== month);
      state.monthlyReports.push({ month, text: res.text, date: today() });
      aiBusy = false; await persist(); render();
    };
  }

  // ---------------- PIN lock ----------------
  async function sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('leons-ledger:' + text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function keypad(title, onDone, opts) {
    const root = opts && opts.lock ? $('#lockRoot') : $('#modalRoot');
    let pin = '';
    root.innerHTML = `<div class="${opts && opts.lock ? 'lock-screen' : 'modal-bg'}"><div class="pin-box">
      ${opts && opts.lock ? `<div class="logo lock-logo">${$('.brand .logo').innerHTML}</div>` : ''}
      <h2>${esc(title)}</h2><div class="pin-dots">${'<i></i>'.repeat(4)}</div><div class="pin-err small bad"></div>
      <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => k === '' ? '<span></span>' : `<button class="btn pin-key" data-k="${k}">${k}</button>`).join('')}</div>
      ${opts && opts.lock ? '' : '<button class="btn ghost mt" data-x>Cancel</button>'}</div></div>`;
    const box = $('.pin-box', root);
    const draw = () => $$('.pin-dots i', box).forEach((d, i) => d.classList.toggle('on', i < pin.length));
    const press = async (k) => {
      if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      draw();
      if (pin.length === 4) { const p = pin; pin = ''; const ok = await onDone(p); if (ok === false) { $('.pin-err', box).textContent = 'Wrong PIN'; box.classList.add('shake'); setTimeout(() => { box.classList.remove('shake'); draw(); }, 400); } }
    };
    $$('.pin-key', box).forEach((b) => (b.onclick = () => press(b.dataset.k)));
    const onKey = (e) => { if (!root.contains(box)) return document.removeEventListener('keydown', onKey); if (/^[0-9]$/.test(e.key)) press(e.key); if (e.key === 'Backspace') press('⌫'); };
    document.addEventListener('keydown', onKey);
    if ($('[data-x]', root)) $('[data-x]', root).onclick = () => { root.innerHTML = ''; };
    return () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  }
  function pinDialog(title, cb) { const close = keypad(title, async (p) => { close(); await cb(p); }); }
  function lockScreen() {
    return new Promise((resolve) => {
      const close = keypad('Enter your PIN', async (p) => { if ((await sha(p)) === state.settings.pinHash) { close(); resolve(); return true; } return false; }, { lock: true });
    });
  }

  // ---------------- Recurring bills ----------------
  async function processRecurring() {
    const due = L.dueRecurring(state);
    let changed = false;
    for (const r of due) {
      if (r.auto) {
        const tx = L.recurringTx(r, today()); state.transactions.push(tx); r.lastLogged = L.monthKey(today()); changed = true;
        toast(`${r.name}: ${m(r.amount)} logged automatically.`);
      } else if (!r.notified || r.notified !== today()) {
        r.notified = today(); changed = true;
        try { if (window.Notification && Notification.permission === 'granted') new Notification("Bill due — Leon's Ledger", { body: `${r.name}: ${m(r.amount)}`, icon: 'icons/icon-192.png' }); } catch (_) {}
      }
    }
    if (changed) await persist();
    return changed;
  }

  // ---------------- Pointer effects: cursor light + ripples ----------------
  let pointerFrame = 0, lastEvt = null;
  document.addEventListener('mousemove', (e) => {
    lastEvt = e;
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      const el = lastEvt.target.closest && lastEvt.target.closest('.btn, nav button, .tabs button, .card, .plan-sec');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (lastEvt.clientX - r.left) + 'px');
      el.style.setProperty('--my', (lastEvt.clientY - r.top) + 'px');
      const card = el.closest('.card, .plan-sec');
      if (card && card !== el) { const c = card.getBoundingClientRect(); card.style.setProperty('--mx', (lastEvt.clientX - c.left) + 'px'); card.style.setProperty('--my', (lastEvt.clientY - c.top) + 'px'); }
    });
  }, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn, nav button, .tabs button');
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(span);
    setTimeout(() => span.remove(), 650);
  });

  // ---------------- Boot ----------------
  $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.page)));
  const isPhone = () => matchMedia('(max-width: 760px)').matches;
  const closeDrawer = () => document.body.classList.remove('sb-open');
  $('#sbToggle').onclick = () => {
    if (isPhone()) document.body.classList.toggle('sb-open');
    else { document.body.classList.toggle('sb-collapsed'); root.device.sbCollapsed = document.body.classList.contains('sb-collapsed'); api.save(root); }
  };
  $('#sbBackdrop').onclick = closeDrawer;
  $$('#nav button').forEach((b) => { b.title = b.textContent.trim(); b.addEventListener('click', () => { if (isPhone()) closeDrawer(); }); });
  (() => { let x0 = null; const sb = $('.sidebar');
    sb.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    sb.addEventListener('touchend', (e) => { if (x0 != null && x0 - e.changedTouches[0].clientX > 60) closeDrawer(); x0 = null; }); })();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#fab').onclick = openAddSheet;
  (async () => {
    loadRoot(await api.load());
    applyTheme();
    document.body.classList.toggle('sb-collapsed', !!root.device.sbCollapsed);
    if (state.settings.pinHash) await lockScreen();
    await processRecurring();
    await persist();
    const v = await api.version();
    $('#versionLabel').textContent = 'v' + v;
    render();
    animateEntrance();
    setInterval(async () => { if (await processRecurring()) render(); }, 30 * 60 * 1000);
    $('#bookSwitch').onchange = (e) => { closeDrawer(); switchBook(e.target.value); };
    await discover(); drawSync();
    if (page === 'settings') render();
    syncActive();
    setInterval(() => syncActive(), 60 * 1000);
    window.addEventListener('focus', () => syncActive());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncActive(); });
  })();
})();
