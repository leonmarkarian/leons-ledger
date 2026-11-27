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
  let planEditing = false;     // split plan: overview (false) or editor (true)
  let planExample = null;      // example paycheck used to show the plan in money
  const planOpen = new Set();  // category detail panels open in the editor
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
      'You see their split plan (buckets and categories with percentages), current balances, debts, goals, wallets and recent activity.',
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
      const recent = activity().slice(0, 5);
      const wallets = L.walletBalances(state);
      const due = L.dueRecurring(state).filter((r) => !r.auto);
      const byType = (types) => L.round2(L.sum(b.sections.filter((s) => types.includes(s.type)), (s) => s.available));
      const left = byType(['spend', 'other']); const saved = byType(['save', 'invest']); const biz = byType(['business']);
      const owed = L.round2(L.sum(b.sections.filter((s) => s.type === 'debt').flatMap((s) => s.categories), (c) => c.progress && c.progress.kind === 'debt' ? c.progress.remaining : 0));
      const inWallets = L.round2(L.sum(wallets, (w) => w.balance));
      const meta = root.meta[root.active];
      const hour = new Date().getHours(); const hi = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      const who = state.settings.userName ? `, ${esc(state.settings.userName)}` : '';
      return `
        ${Object.keys(root.books).length > 1 ? `<div class="mobile-book"><select id="bookSwitch2">${Object.keys(root.books).map((k) => `<option value="${k}" ${k === root.active ? 'selected' : ''}>${esc(root.meta[k].name || 'Budget')}${root.meta[k].shared ? ' 👥' : ''}</option>`).join('')}</select></div>` : ''}
        <div class="home-top"><p class="muted hi">${hi}${who}</p><h1>${meta.shared ? esc(meta.name) : 'Home'}</h1>
          ${meta.shared && meta.members ? `<div class="members">${meta.members.map((u) => `<span class="avatar" title="${esc(u)}">${esc(u.charAt(0).toUpperCase())}</span>`).join('')}<span class="muted small">${meta.members.map(nice).map(esc).join(' & ')}${syncState.status === 'ok' ? ' · <span class="good">✓ Synced</span>' : ''}</span></div>` : ''}</div>
        <div class="card hero">
          <div class="label">Left to spend</div>
          <div class="value ${left < 0 ? 'bad' : ''}" data-count="${left}">${m(left)}</div>
          <div class="hero-row">
            <div><span>Saved</span><b>${m(saved)}</b></div>
            ${owed > 0 ? `<div><span>Still owed</span><b>${m(owed)}</b></div>` : ''}
            <div><span>In your wallets</span><b>${m(inWallets)}</b></div>
            ${biz ? `<div><span>Business</span><b>${m(biz)}</b></div>` : ''}
          </div>
        </div>
        <div class="quick">
          <button class="btn primary big-btn" data-go="income"><span>＋</span> Money in</button>
          <button class="btn big-btn" data-go="spend" data-mode="spend"><span>−</span> Money out</button>
        </div>
        ${due.length ? `<div class="card mt due-card"><h2>🔔 Bills due</h2>
          ${due.map((r) => `<div class="row between due-row"><div><b>${esc(r.name)}</b> <span class="muted small">${m(r.amount)} · due the ${ord(r.day)}</span></div><button class="btn sm primary" data-paydue="${r.id}">Mark paid</button></div>`).join('')}
        </div>` : ''}
        <div class="card mt"><div class="row between"><h2>Your buckets</h2><button class="btn sm ghost" data-go="plan">Plan</button></div>
          <div class="bk-list">${b.sections.map((sec) => bucketRow(sec)).join('')}</div>
        </div>
        <div class="card mt"><div class="row between"><h2>Recent</h2><button class="btn sm ghost" data-go="history">See all</button></div>
          ${recent.length ? activityList(recent, false) : '<div class="empty">Nothing yet. Tap <b>Money in</b> when you get paid.</div>'}</div>`;
    },

    income() {
      const preview = incomePreviewHtml(0);
      return `<h1>Money in</h1><p class="sub">Type what you got paid. It's split into your buckets automatically.</p>
        <div class="grid g12">
          <div class="card">
            <label class="f">How much?<div class="amount-row"><input class="big" id="incAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" autofocus>${currencySelect('incCur')}</div></label>
            <div class="small muted mt-s" id="incConv"></div>
            <label class="f mt">Into<select id="incWallet">${walletOptions()}</select></label>
            <details class="more mt"><summary>More details</summary>
              <div class="form-grid mt-s">
                <label class="f">Date<input id="incDate" type="date" value="${today()}"></label>
                <label class="f">From<input id="incSource" placeholder="e.g. Salary"></label>
                <label class="f full">Note<input id="incNote" placeholder="Optional"></label>
              </div>
              <label class="row mt-s small muted"><input type="checkbox" id="incCustom"> Change the split for this paycheck only</label>
            </details>
            <div class="errors mt-s" id="incErr"></div>
            <button class="btn primary mt" id="incSave" style="width:100%">Save</button>
          </div>
          <div class="card"><h2>Where it goes</h2><div id="incPreview">${preview}</div></div>
        </div>
        ${lastIncomeId ? lastIncomeAdviceHtml() : ''}`;
    },

    spend() {
      const titles = { spend: ['Money out', 'Something you bought or paid.'], transfer: ['Move money', 'Shift money between buckets or between wallets.'], wallet: ['Move money', 'Shift money between buckets or between wallets.'], recurring: ['Repeating bills', 'Rent, subscriptions, loans: logged or reminded every month.'] };
      const [t, sub] = titles[spendTab];
      const toggle = spendTab === 'transfer' || spendTab === 'wallet' ? `<div class="seg mt-s"><button data-tab="transfer" class="${spendTab === 'transfer' ? 'active' : ''}">Between buckets</button><button data-tab="wallet" class="${spendTab === 'wallet' ? 'active' : ''}">Between wallets</button></div>` : '';
      const links = spendTab === 'spend' ? `<div class="sub-links"><button class="link" data-tab="transfer">⇄ Move money</button><button class="link" data-tab="recurring">🔁 Repeating bills</button></div>` : `<div class="sub-links"><button class="link" data-tab="spend">← Back to Money out</button></div>`;
      return `<h1>${t}</h1><p class="sub">${sub}</p>${toggle}
        ${lastPaymentMsg ? `<div class="card result-card mt">✓ ${esc(lastPaymentMsg)}</div>` : ''}
        ${({ spend: spendForm, transfer: transferForm, wallet: walletTransferForm, recurring: recurringPanel })[spendTab]()}
        ${links}`;
    },

    plan() {
      if (planExample == null) { const avg = L.avgMonthlyIncome(state, 3); planExample = avg ? Math.round(avg / 10) * 10 : 1000; }
      return planEditing ? planEditorHtml() : planOverviewHtml();
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
      return `<div class="row between"><div><h1>History</h1><p class="sub">Everything you've logged. Tap ✎ to edit or ✕ to delete.</p></div><button class="btn sm" data-go="reports">▦ Reports & export</button></div>
        <div class="tabs">${[['all', 'All'], ['income', 'Income'], ['spend', 'Spending & payments'], ['transfer', 'Transfers']].map(([k, l]) => `<button data-filter="${k}" class="${historyFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="card">${rows.length ? activityList(rows, true) : '<div class="empty">Nothing here yet.</div>'}</div>`;
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
          ${state.chat.length ? '<button class="btn ghost" id="chatClear" title="Clear chat">Clear</button>' : ''}</div>
          <p class="muted small" style="margin:10px 0 0">AI can make mistakes. Answers are general guidance, not professional financial advice.</p></div>`;
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
            <div class="row mt-s wrap"><button class="btn primary" id="accLogin">Log in</button><button class="btn" id="accSignup">Create account</button><a href="#" id="accForgot" class="small">Forgot password?</a></div>
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
            ${Object.keys(root.books).length > 1 ? `<div class="mt-s small muted">Switch between budgets from the menu at the top of the sidebar.</div>` : ''}
            ${acc.hasRecovery === false ? `<div class="warn-box mt"><b>⚠ No recovery code yet.</b> If you forget your password you'd lose access. <button class="btn sm" id="secRecovery2">Create one now</button></div>` : ''}`}
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
            ${acc ? `<div class="card"><h2>Account security</h2>
              <p class="muted small" style="margin-top:0">Signed in as <b>${esc(acc.username)}</b>.</p>
              <div class="row wrap"><button class="btn" id="secPass">Change password</button><button class="btn" id="secRecovery">New recovery code</button></div>
              <button class="btn ghost danger mt" id="secDelete">Delete my account…</button>
            </div>` : ''}
            <div class="card"><h2>About & legal</h2>
              <p class="muted small" style="margin-top:0">Leon's Ledger v<span class="verText2"></span>. AI answers are general guidance, not professional financial advice.</p>
              <div class="row wrap"><a class="btn" href="${PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a><a class="btn" href="${TERMS_URL}" target="_blank" rel="noopener">Terms of Use</a><a class="btn ghost" href="mailto:${CONTACT}">Contact</a></div>
            </div>
            <div class="card"><h2>Updates</h2>
              <p class="muted small" style="margin-top:0" id="updText">Version <span id="verText"></span>. ${api.platform === 'web' ? 'The app updates itself automatically whenever you open it online.' : 'The app checks for updates automatically on launch.'}</p>
              <button class="btn" id="uCheck">Check for updates</button>
            </div>
        </div>`;
    }
  };

  // ---------------- Split plan: overview + editor ----------------
  const PURPOSE = { spend: 'money you use day to day', save: 'kept for your goals', debt: 'goes to what you owe', invest: 'put to work', business: 'kept apart for your business', other: 'for anything else' };
  const pctTxt = (x) => `${L.round2(x)}%`;
  function planBar(sections) {
    return `<div class="split-bar big">${sections.map((s) => `<i style="width:${Number(s.percent) || 0}%;background:${s.color}" title="${esc(s.name)} ${s.percent}%">${(Number(s.percent) || 0) >= 9 ? `<span>${L.round2(s.percent)}%</span>` : ''}</i>`).join('')}</div>`;
  }
  function catChips(sec, c) {
    const out = [];
    if (sec.type === 'debt') {
      if (c.target) out.push(`Owes ${m(c.target)}`);
      if (c.apr) out.push(`${L.round2(c.apr)}% interest/yr`);
      if (c.minPayment) out.push(`min ${m(c.minPayment)}/month`);
    } else if (c.target) out.push(`Goal ${m(c.target)}`);
    if (c.note) out.push(esc(c.note));
    return out.length ? `<div class="chips">${out.map((x) => `<span class="chip">${x}</span>`).join('')}</div>` : '';
  }
  function planOverviewHtml() {
    const secs = state.sections;
    return `<div class="plan-top"><h1>Split plan</h1><p class="sub">How every paycheck is divided between your buckets.</p></div>
      <div class="card plan-ov">
        ${planBar(secs)}
        <div class="ov-list">${secs.map((sec, si) => `
          <div class="ov-sec" style="--c:${sec.color}">
            <div class="ov-head"><span class="dot"></span>
              <div class="ov-name"><b>${esc(sec.name)}</b><span class="muted small">${L.SECTION_TYPES[sec.type].label} · ${PURPOSE[sec.type] || ''}</span></div>
              <div class="ov-amt"><b>${pctTxt(sec.percent)}</b><span class="muted small">of paycheck</span></div></div>
            <div class="ov-cats">${sec.categories.map((c, ci) => `
              <div class="ov-cat">
                <div class="ov-cat-name"><span>${esc(c.name)}</span>${sec.categories.length > 1 ? `<span class="muted small">${pctTxt(c.percent)} of ${esc(sec.name)}</span>` : ''}${catChips(sec, c)}</div>
                <b>${pctTxt(sec.percent * c.percent / 100)}</b>
                <div class="mini-bar"><i style="width:${Number(c.percent) || 0}%"></i></div>
              </div>`).join('')}</div>
          </div>`).join('')}</div>
      </div>
      <button class="btn primary plan-edit-btn" id="planEdit">✎ Edit plan</button>
      <p class="muted small">Changing the plan only affects future paychecks. Past ones keep the split they were saved with, so your history stays accurate.</p>`;
  }
  function assignStatus(total, ofWhat) {
    const d = L.round2(100 - total);
    if (Math.abs(d) < 0.001) return { cls: 'good', text: `100% of ${ofWhat} assigned ✓` };
    return d > 0 ? { cls: 'warn', text: `${d}% of ${ofWhat} still to assign` } : { cls: 'bad', text: `${-d}% too much — lower something` };
  }
  function detailsLabel(sec, c) {
    if (sec.type === 'debt') return c.target ? `Owes ${m(c.target)}` : 'Debt details';
    return c.target ? `Goal ${m(c.target)}` : (c.note ? 'Note' : 'Goal / note');
  }
  function planEditorHtml() {
    if (!draftPlan) draftPlan = JSON.parse(JSON.stringify(state.sections));
    const v = L.validatePlan(draftPlan); const st = assignStatus(v.total, 'your paycheck');
    const types = Object.entries(L.SECTION_TYPES); const ex = planExample;
    return `<div class="sticky-bar plan-edit-bar"><div class="row between"><div><h1>Edit split plan</h1>
          <div class="assign ${st.cls}" id="planStatus">${st.text}</div></div>
        <div class="row"><button class="btn ghost" id="planCancel">Cancel</button><button class="btn primary" id="planSave" ${v.ok ? '' : 'disabled'}>Save plan</button></div></div>
        <div class="errors" id="planErrors">${v.errors.filter((e) => !/^Buckets add up/.test(e)).map((e) => `<div>• ${esc(e)}</div>`).join('')}</div></div>
      <p class="muted small">Amounts are shown for a ${m(ex)} paycheck and update as you type.</p>
      ${draftPlan.map((sec, si) => {
        const ct = L.round2(L.sum(sec.categories, (c) => Number(c.percent) || 0)); const cs = assignStatus(ct, esc(sec.name || 'this bucket'));
        return `<div class="plan-sec" style="--c:${sec.color}">
          <div class="ps-head">
            <input type="color" value="${sec.color}" data-s="${si}" data-k="color" title="Bucket colour">
            <label class="f ps-name">Bucket name<input value="${esc(sec.name)}" data-s="${si}" data-k="name" placeholder="e.g. Needs"></label>
            <label class="f ps-type">Used for<select data-s="${si}" data-k="type">${types.map(([k, t]) => `<option value="${k}" ${sec.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
            <label class="f ps-pct">Share of paycheck<div class="pct-input"><input type="text" inputmode="decimal" autocomplete="off" value="${sec.percent}" data-s="${si}" data-k="percent"></div></label>
            <button class="icon-btn ps-del" data-delsec="${si}" title="Delete bucket">✕</button>
          </div>
          <div class="ps-help muted small" data-sechelp="${si}">= <b>${m(ex * (Number(sec.percent) || 0) / 100)}</b> of every ${m(ex)} paycheck</div>
          <div class="ps-cats">
            <div class="ps-cats-head"><span class="small"><b>Categories in ${esc(sec.name || 'this bucket')}</b></span>
              <span class="assign small ${cs.cls}" data-catstatus="${si}">${cs.text}</span>
              <button class="btn sm ghost ${Math.abs(ct - 100) > 0.001 ? '' : 'hidden'}" data-even="${si}">Split evenly</button></div>
            ${sec.categories.map((c, ci) => { const key = si + '|' + ci; const open = planOpen.has(sec.id + '|' + c.id);
              return `<div class="pc-row ${open ? 'open' : ''}">
                <label class="f pc-name">Category<input value="${esc(c.name)}" data-s="${si}" data-c="${ci}" data-k="name" placeholder="e.g. Groceries"></label>
                <label class="f pc-pct">% of ${esc(sec.name || 'bucket')}<div class="pct-input"><input type="text" inputmode="decimal" autocomplete="off" value="${c.percent}" data-s="${si}" data-c="${ci}" data-k="percent"></div></label>
                <div class="pc-amt" data-cathelp="${key}"><b>${m(ex * (Number(sec.percent) || 0) / 100 * (Number(c.percent) || 0) / 100)}</b><span class="muted small">${pctTxt((Number(sec.percent) || 0) * (Number(c.percent) || 0) / 100)} of paycheck</span></div>
                <button class="btn sm ghost pc-more" data-details="${sec.id}|${c.id}">${detailsLabel(sec, c)} <span class="chev">▾</span></button>
                <button class="icon-btn pc-del" data-delcat="${key}" title="Delete category">✕</button>
                <div class="pc-details">
                  ${sec.type === 'debt' ? `
                    <label class="f">Total owed<div class="money-input" data-sym="${sym()}"><input type="text" inputmode="decimal" autocomplete="off" value="${c.target || ''}" placeholder="0" data-s="${si}" data-c="${ci}" data-k="target"></div></label>
                    <label class="f">Interest per year<div class="pct-input"><input type="text" inputmode="decimal" autocomplete="off" value="${c.apr || ''}" placeholder="0" data-s="${si}" data-c="${ci}" data-k="apr"></div></label>
                    <label class="f">Minimum monthly payment<div class="money-input" data-sym="${sym()}"><input type="text" inputmode="decimal" autocomplete="off" value="${c.minPayment || ''}" placeholder="0" data-s="${si}" data-c="${ci}" data-k="minPayment"></div></label>`
                  : `<label class="f">${sec.type === 'spend' ? 'Target amount (optional)' : 'Goal amount (optional)'}<div class="money-input" data-sym="${sym()}"><input type="text" inputmode="decimal" autocomplete="off" value="${c.target || ''}" placeholder="e.g. 5000" data-s="${si}" data-c="${ci}" data-k="target"></div></label>
                    <label class="f pc-note">Note (optional)<input value="${esc(c.note || '')}" data-s="${si}" data-c="${ci}" data-k="note" placeholder="Anything to remember"></label>`}
                </div>
              </div>`; }).join('')}
            <button class="btn sm" data-addcat="${si}">＋ Add category</button>
          </div></div>`;
      }).join('')}
      <button class="btn add-bucket" id="planAddSec">＋ Add bucket</button>
      <p class="muted small">Changing the plan only affects future paychecks. Past ones keep the split they were saved with.</p>`;
  }

  // ---------------- Page fragments ----------------
  function bucketRow(sec) {
    const kept = sec.type === 'save' || sec.type === 'invest';
    const cats = sec.categories;
    let pct, cls = '';
    if (sec.type === 'debt') {
      const t = L.sum(cats, (c) => (c.progress && c.progress.target) || 0); const d = L.sum(cats, (c) => (c.progress && c.progress.done) || 0);
      pct = t ? (d / t) * 100 : 0;
    } else if (kept) {
      const t = L.sum(cats, (c) => c.target || 0); pct = t ? Math.min(100, (Math.max(0, sec.available) / t) * 100) : 0;
    } else {
      const got = L.sum(cats, (c) => c.allocated + c.transferIn - c.transferOut); const spent = L.sum(cats, (c) => c.spent);
      pct = got > 0 ? Math.min(100, (spent / got) * 100) : 0; if (spent > got) cls = 'over';
    }
    const word = sec.available < 0 ? 'over' : kept ? 'saved' : sec.type === 'debt' ? 'to pay' : 'left';
    const amt = sec.available < 0 ? m(-sec.available) : m(sec.available);
    return `<details class="bk" style="--c:${sec.color}"><summary>
        <span class="dot"></span><span class="bk-name">${esc(sec.name)}</span>
        <span class="bk-amt ${sec.available < 0 ? 'bad' : ''}"><b>${amt}</b><small>${word}</small></span>
        <span class="bar ${cls}"><i style="width:${pct}%"></i></span></summary>
      <div class="bk-cats">${cats.map((c) => {
        const got = L.round2(c.allocated + c.transferIn - c.transferOut);
        let line;
        if (c.progress && c.progress.kind === 'debt') line = `${m(c.progress.remaining)} still owed`;
        else if (c.progress) line = `${Math.round(c.progress.pct)}% of ${m(c.progress.target)} goal`;
        else if (got > 0 || c.spent) line = `${m(c.spent)} of ${m(got)} used`;
        else line = 'Nothing yet';
        return `<div class="bk-cat"><span>${esc(c.name)}<small class="muted">${line}</small></span><b class="${c.available < 0 ? 'bad' : ''}">${c.available < 0 ? '−' + m(-c.available) : m(c.available)}</b></div>`;
      }).join('')}</div></details>`;
  }
  function sectionCard(s) {
    const type = L.SECTION_TYPES[s.type];
    const kept = s.type === 'save' || s.type === 'invest';
    const head = s.available < 0 ? `<span class="bad">Over by ${m(-s.available)}</span>` : m(s.available);
    return `<div class="card section-card" style="--c:${s.color}">
      <div class="section-head"><div><div class="name">${esc(s.name)}</div><div class="muted small">${L.round2(s.percent)}% of each paycheck · ${type.label}</div></div>
        <div class="sec-total"><b>${head}</b><span class="muted small">${s.available < 0 ? 'overspent' : kept ? 'saved' : 'available'}</span></div></div>
      ${s.categories.map((c) => {
        const got = L.round2(c.allocated + c.transferIn - c.transferOut);
        let line, barPct, barCls = '', label = kept ? 'saved' : s.type === 'debt' ? 'ready to pay' : 'left';
        if (c.progress && c.progress.kind === 'debt') {
          line = `${m(c.progress.done)} paid · <b>${m(c.progress.remaining)} still owed</b> of ${m(c.progress.target)}`; barPct = c.progress.pct;
        } else if (c.progress) {
          line = `${m(Math.max(0, c.available))} of ${m(c.progress.target)} goal · ${Math.round(c.progress.pct)}%`; barPct = c.progress.pct;
        } else if (got > 0 || c.spent) {
          line = `Received ${m(got)} · ${type.past} ${m(c.spent)}`;
          barPct = got > 0 ? Math.min(100, (c.spent / got) * 100) : 100; if (c.spent > got) barCls = 'over';
        } else { line = `Gets ${L.round2(s.percent * c.percent / 100)}% of each paycheck`; barPct = 0; }
        const amt = c.available < 0 ? `<span class="bad">Over by ${m(-c.available)}</span>` : m(c.available);
        return `<div class="cat-row"><div><div>${esc(c.name)}</div><div class="muted small">${line}</div></div>
          <div class="amt">${amt}<div class="muted small" style="font-weight:400">${c.available < 0 ? 'over budget' : label}</div></div>
          <div class="bar ${barCls}"><i style="width:${barPct}%"></i></div></div>`;
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

  function activityList(rows, editable) {
    const ico = { income: ['in', '＋'], spend: ['out', '−'], transfer: ['tr', '⇄'] };
    return `<div class="act-list">${rows.map((r) => `<div class="act-row">
        <span class="act-ico ${ico[r.kind][0]}">${ico[r.kind][1]}</span>
        <div class="act-main"><div class="act-what">${esc(r.what)}</div>
          <div class="muted small">${fmtDate(r.date)}${r.detail ? ' · ' + esc(r.detail) : ''}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        <div class="act-amt ${r.kind === 'income' ? 'good' : r.kind === 'spend' ? 'bad' : ''}">${r.kind === 'income' ? '+' : ''}${m(r.amount)}</div>
        ${editable ? `<div class="act-tools">${r.wallet ? '' : `<button class="icon-btn" data-edit="${r.kind}|${r.id}" title="Edit">✎</button>`}<button class="icon-btn" data-del="${r.wallet ? 'wtransfer' : r.kind}|${r.id}" title="Delete">✕</button></div>` : ''}
      </div>`).join('')}</div>`;
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
    const secs = state.sections.map((s, i) => Object.assign({}, s, { percent: split.sectionAmounts[i].percent }));
    return `${amount ? '' : '<p class="muted small" style="margin-top:0">Type an amount to see where it goes.</p>'}
    ${planBar(secs)}
    ${state.sections.map((s, i) => {
      const sa = split.sectionAmounts[i];
      return `<div class="pv-sec" style="--c:${s.color}">
        <div class="pv-head"><span class="dot"></span><b>${esc(s.name)}</b>
          ${custom ? `<div class="pct-input pv-pct"><input type="text" inputmode="decimal" autocomplete="off" data-ov="${s.id}" value="${sa.percent}"></div>` : `<span class="muted small">${sa.percent}%</span>`}
          <b class="pv-amt" data-secamt="${s.id}">${m(sa.amount)}</b></div>
        ${s.categories.length > 1 || s.categories[0].name !== s.name ? `<div class="pv-cats">${s.categories.map((c) => { const a = split.allocations.find((x) => x.categoryId === c.id); return `<div class="pv-cat"><span>${esc(c.name)}</span><span data-catamt="${c.id}">${m(a.amount)}</span></div>`; }).join('')}</div>` : ''}
      </div>`;
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
    return `<div class="card simple-form">
      <div class="row between"><span class="f-label">How much?</span>
        <button class="btn sm" id="spScan" ${scanBusy ? 'disabled' : ''}>${scanBusy ? 'Reading receipt…' : '📷 Scan receipt'}</button><input type="file" id="spScanFile" accept="image/*" capture="environment" class="hidden"></div>
      <div class="amount-row mt-s"><input class="big" id="spAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00">${currencySelect('spCur')}</div>
      <div class="small muted mt-s" id="spConv"></div>
      <label class="f mt">From which bucket?<select id="spCat">${categoryOptions(spendForm.last)}</select></label>
      <div id="spAvail" class="small mt-s"></div>
      <label class="f mt">Paid with<select id="spWallet">${walletOptions(spendForm.lastWallet)}</select></label>
      <details class="more mt"><summary>More details</summary>
        <div class="form-grid mt-s">
          <label class="f">Date<input id="spDate" type="date" value="${today()}"></label>
          <label class="f">Note<input id="spNote" placeholder="e.g. groceries"></label>
        </div>
      </details>
      <button class="btn primary mt" id="spSave" style="width:100%">Save</button>
    </div>`;
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
      { icon: '＋', label: 'Money in', sub: 'You got paid', run: () => go('income') },
      { icon: '−', label: 'Money out', sub: 'You bought or paid something', run: () => { spendTab = 'spend'; go('spend'); } },
      { icon: '📷', label: 'Scan a receipt', sub: 'Fills in Money out for you', run: () => { spendTab = 'spend'; go('spend'); const f = $('#spScanFile'); if (f) f.click(); } },
      { icon: '⇄', label: 'Move money', sub: 'Between buckets or wallets', run: () => { spendTab = 'transfer'; go('spend'); } }
    ]);
  }
  function openMoreSheet() {
    const keys = Object.keys(root.books);
    const switcher = keys.length > 1 ? `<div class="sheet-books">${keys.map((k) => `<button class="book-chip ${k === root.active ? 'active' : ''}" data-book="${k}">${esc(root.meta[k].name || 'Budget')}${root.meta[k].shared ? ' 👥' : ''}</button>`).join('')}</div>` : '';
    const status = root.account ? `<div class="sheet-status small muted">Signed in as <b>${esc(root.account.username)}</b>${syncState.status === 'ok' ? ' · <span class="good">✓ Synced</span>' : syncState.status === 'offline' ? ' · Offline' : ''}</div>` : '';
    const sh = sheet('More', [
      { icon: '◎', label: 'Goals & debts', sub: 'When you’ll reach each goal', run: () => go('goals') },
      { icon: '%', label: 'Split plan', sub: 'See and change how paychecks split', run: () => go('plan') },
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
    if (page === 'plan' && p !== 'plan') { draftPlan = null; planEditing = false; }
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
    $$('[data-go]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); if (b.dataset.mode) spendTab = b.dataset.mode; go(b.dataset.go); }));
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
      split.allocations.forEach((a) => { const d = $(`[data-catamt="${a.categoryId}"]`); if (d) d.textContent = m(a.amount); });
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
      if (ov) { const t = L.round2(L.sum(Object.values(ov))); if (Math.abs(t - 100) > 0.001) { err.textContent = `Bucket percentages add up to ${t}% — they need to total 100%.`; return; } }
      const split = L.splitIncome(amount, state.sections, ov);
      const income = { id: L.uid('inc'), createdAt: Date.now(), by: whoAmI(), date: $('#incDate').value || today(), amount, walletId: $('#incWallet').value, original: amt0.original, source: $('#incSource').value.trim(), note: $('#incNote').value.trim(), allocations: split.allocations, advice: '' };
      state.incomes.push(income);
      await persist();
      lastIncomeId = income.id;
      toast(`${m(amount)} logged and split into your ${state.sections.length} buckets.`);
      if (state.settings.autoAdviceOnIncome) adviseOnIncome(income); else render();
    };
  }

  function bindSpend() {
    $$('[data-tab]').forEach((b) => (b.onclick = () => { spendTab = b.dataset.tab; lastPaymentMsg = null; render(); }));
    if (spendTab === 'spend') {
      const upd = () => {
        spendForm.last = $('#spCat').value; const [sid, cid] = spendForm.last.split('|'); const bb = L.balances(state).get(sid, cid);
        $('#spAvail').innerHTML = bb ? (bb.available >= 0 ? `<span class="muted">You have <b class="good">${m(bb.available)}</b> left here.</span>` : `<span class="bad">This bucket is already over by ${m(-bb.available)}.</span>`) : '';
      };
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
    if (!planEditing) {
      $('#planEdit').onclick = () => { planEditing = true; draftPlan = null; render(); $('#main').scrollTop = 0; };
      return;
    }
    $$('[data-k]').forEach((el) => {
      const evt = el.type === 'color' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const sec = draftPlan[+el.dataset.s]; const k = el.dataset.k;
        const target = el.dataset.c != null ? sec.categories[+el.dataset.c] : sec;
        target[k] = ['percent', 'target', 'apr', 'minPayment'].includes(k) ? num(el.value) : el.value;
        if (k === 'color' || k === 'type') rerender();       // a picker changed: safe to redraw
        else updateLive();                                   // typing: update numbers in place (no jumping cursor)
      });
    });
    function updateLive() {
      const ex = planExample;
      const v = L.validatePlan(draftPlan); const st = assignStatus(v.total, 'your paycheck');
      const ps = $('#planStatus'); ps.textContent = st.text; ps.className = 'assign ' + st.cls;
      $('#planErrors').innerHTML = v.errors.filter((e) => !/^Buckets add up/.test(e)).map((e) => `<div>• ${esc(e)}</div>`).join('');
      $('#planSave').disabled = !v.ok;
      draftPlan.forEach((sec, si) => {
        const sp = Number(sec.percent) || 0;
        const h = $(`[data-sechelp="${si}"]`); if (h) h.innerHTML = `= <b>${m(ex * sp / 100)}</b> of every ${m(ex)} paycheck`;
        const ct = L.round2(L.sum(sec.categories, (c) => Number(c.percent) || 0)); const cs = assignStatus(ct, esc(sec.name || 'this bucket'));
        const el = $(`[data-catstatus="${si}"]`); if (el) { el.textContent = cs.text; el.className = 'assign small ' + cs.cls; }
        const ev = $(`[data-even="${si}"]`); if (ev) ev.classList.toggle('hidden', Math.abs(ct - 100) < 0.001);
        sec.categories.forEach((c, ci) => {
          const x = $(`[data-cathelp="${si}|${ci}"]`); const cp = Number(c.percent) || 0;
          if (x) x.innerHTML = `<b>${m(ex * sp / 100 * cp / 100)}</b><span class="muted small">${pctTxt(sp * cp / 100)} of paycheck</span>`;
        });
      });
    }
    $$('[data-details]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.details; const row = b.closest('.pc-row');
      if (planOpen.has(k)) planOpen.delete(k); else planOpen.add(k);
      row.classList.toggle('open', planOpen.has(k));
      if (planOpen.has(k)) { const f = $('.pc-details input', row); if (f) setTimeout(() => f.focus(), 50); }
    }));
    $('#planAddSec').onclick = () => { draftPlan.push({ id: L.uid('sec'), name: 'New bucket', type: 'other', percent: 0, color: L.PALETTE[draftPlan.length % L.PALETTE.length], categories: [{ id: L.uid('cat'), name: 'General', percent: 100, target: 0, note: '' }] }); rerender(); };
    $$('[data-addcat]').forEach((b) => (b.onclick = () => { draftPlan[+b.dataset.addcat].categories.push({ id: L.uid('cat'), name: 'New category', percent: 0, target: 0, note: '' }); rerender(); }));
    $$('[data-even]').forEach((b) => (b.onclick = () => {
      const cats = draftPlan[+b.dataset.even].categories; const parts = L.distribute(100, cats.map(() => 1));
      cats.forEach((c, i) => (c.percent = parts[i])); rerender();
    }));
    $$('[data-delcat]').forEach((b) => (b.onclick = async () => {
      const [si, ci] = b.dataset.delcat.split('|').map(Number); const sec = draftPlan[si];
      if (sec.categories.length === 1) return toast('A bucket needs at least one category — delete the bucket instead.', true);
      if (hasHistory(sec.id, sec.categories[ci].id) && !(await confirmBox('Delete category?', `"${sec.categories[ci].name}" has history. Its past entries will stay in History but show as a deleted category.`, 'Delete'))) return;
      sec.categories.splice(ci, 1); rerender();
    }));
    $$('[data-delsec]').forEach((b) => (b.onclick = async () => {
      const sec = draftPlan[+b.dataset.delsec];
      if (!(await confirmBox('Delete bucket?', `Delete "${sec.name}" and all its categories? Past entries stay in History.`, 'Delete'))) return;
      draftPlan.splice(+b.dataset.delsec, 1); rerender();
    }));
    $('#planCancel').onclick = () => { draftPlan = null; planEditing = false; render(); $('#main').scrollTop = 0; };
    $('#planSave').onclick = async () => {
      draftPlan.forEach((x) => { x.name = x.name.trim() || 'Untitled'; x.categories.forEach((c) => (c.name = c.name.trim() || 'Untitled')); });
      state.sections = JSON.parse(JSON.stringify(draftPlan));
      state.planUpdatedAt = Date.now();
      await persist(); toast('Plan saved. Your next paycheck will use it.'); draftPlan = null; planEditing = false; render(); $('#main').scrollTop = 0;
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
    api.version().then((v) => { if ($('#verText')) $('#verText').textContent = v; $$('.verText2').forEach((x) => { x.textContent = v; }); });
    if ($('#secRecovery2')) $('#secRecovery2').onclick = () => $('#secRecovery') && $('#secRecovery').click();
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

  // ---------------- Legal & recovery ----------------
  const SITE = location.protocol === 'file:' ? 'https://leonmarkarian.github.io/leons-ledger/' : './';
  const PRIVACY_URL = SITE + 'privacy.html', TERMS_URL = SITE + 'terms.html';
  const CONTACT = 'leonmarkarian99@gmail.com';

  function showRecoveryCode(code, onDone) {
    modal(`<h2>Save your recovery code</h2>
      <p class="muted">If you ever forget your password, this code is the only way back into your account. We can't see or reset it for you.</p>
      <div class="invite-code recovery-code">${esc(code)}</div>
      <div class="row wrap"><button class="btn" data-copy>Copy</button><button class="btn" data-dl>Download as a file</button></div>
      <label class="row small mt"><input type="checkbox" data-ok-check> I've saved my recovery code somewhere safe</label>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" data-ok disabled>Done</button></div>`, (el, close) => {
      $('[data-copy]', el).onclick = async () => { try { await navigator.clipboard.writeText(code); toast('Copied.'); } catch (_) { toast('Select the code and copy it.', true); } };
      $('[data-dl]', el).onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([`Leon's Ledger recovery code\nUsername: ${root.account ? root.account.username : ''}\nRecovery code: ${code}\n\nKeep this private. You need it to reset your password.\n`], { type: 'text/plain' }));
        a.download = 'leons-ledger-recovery-code.txt'; document.body.appendChild(a); a.click(); a.remove();
      };
      $('[data-ok-check]', el).onchange = (e) => { $('[data-ok]', el).disabled = !e.target.checked; };
      $('[data-ok]', el).onclick = () => { close(); if (onDone) onDone(); };
      $('.modal-bg').onmousedown = null;
    });
  }

  function forgotPasswordDialog(prefill, onSuccess) {
    modal(`<h2>Reset your password</h2>
      <p class="muted small">Enter your username, the recovery code you saved when you created your account, and a new password.</p>
      <label class="f">Username<input id="fpUser" value="${esc(prefill || '')}" autocomplete="username"></label>
      <label class="f mt-s">Recovery code<input id="fpCode" placeholder="XXXX-XXXX-XXXX-XXXX" style="text-transform:uppercase" autocomplete="off"></label>
      <label class="f mt-s">New password<input id="fpPass" type="password" placeholder="8+ characters" autocomplete="new-password"></label>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Reset password</button></div>`, (el, close) => {
      $('[data-x]', el).onclick = close;
      $('[data-ok]', el).onclick = async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await call('POST', '/auth/reset', { username: $('#fpUser', el).value.trim(), recoveryCode: $('#fpCode', el).value, newPassword: $('#fpPass', el).value });
          root.account = { token: r.token, username: r.user.username, id: r.user.id }; await api.save(root);
          close(); toast('Password changed — you’re logged in.');
          showRecoveryCode(r.recoveryCode, onSuccess);   // the old code was used up, here's the new one
        } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
      };
    });
  }

  function passwordPrompt(title, text, okLabel, danger, extraHtml) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(title)}</h2><p class="muted">${text}</p>
        <label class="f">Password<input id="ppPass" type="password" autocomplete="current-password"></label>${extraHtml || ''}
        <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`, (el, close) => {
        $('[data-x]', el).onclick = () => { close(); resolve(null); };
        $('[data-ok]', el).onclick = () => { const v = { password: $('#ppPass', el).value, extra: $('[data-extra]', el) ? $('[data-extra]', el).checked : false }; close(); resolve(v); };
        setTimeout(() => $('#ppPass', el).focus(), 50);
      });
    });
  }

  async function deleteAccountFlow() {
    const r = await passwordPrompt('Delete your account?', 'This permanently deletes your account and your synced budget from our server. Shared budgets stay for the other members. <b>This can’t be undone.</b>', 'Delete account', true,
      '<label class="row small mt"><input type="checkbox" data-extra> Also erase all budgets on this device</label>');
    if (!r) return;
    try {
      await call('POST', '/auth/delete', { password: r.password });
      root.account = null; remoteBooks = null;
      Object.keys(root.books).forEach((k) => { if (k !== 'local') { delete root.books[k]; delete root.meta[k]; } });
      delete root.meta.local.remoteId; delete root.meta.local.rev;
      if (r.extra) { root.books.local = L.defaultState(); root.device.onboarded = false; }
      useBook('local'); await api.save(root); syncState.status = 'off'; drawSync();
      toast('Your account was deleted.');
      if (r.extra) location.reload(); else go('settings');
    } catch (e) { toast(e.message, true); }
  }

  // ---------------- Account, sync & shared budgets ----------------
  async function refreshRemoteBooks() {
    try { const r = await call('GET', '/me'); remoteBooks = r.books; if (root.account) { root.account.hasRecovery = !!r.user.hasRecovery; await api.save(root); } } catch (_) { remoteBooks = null; }
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
        if (r.recoveryCode) await new Promise((res) => showRecoveryCode(r.recoveryCode, res));
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
    if ($('#accForgot')) $('#accForgot').onclick = (e) => { e.preventDefault(); forgotPasswordDialog($('#accUser').value.trim(), () => render()); };
    if ($('#secPass')) $('#secPass').onclick = () => {
      modal(`<h2>Change password</h2><label class="f">Current password<input id="cpOld" type="password" autocomplete="current-password"></label>
        <label class="f mt-s">New password<input id="cpNew" type="password" placeholder="8+ characters" autocomplete="new-password"></label>
        <p class="muted small">Your other devices will be logged out.</p>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Change</button></div>`, (el, close) => {
        $('[data-x]', el).onclick = close;
        $('[data-ok]', el).onclick = async () => {
          try { await call('POST', '/auth/password', { oldPassword: $('#cpOld', el).value, newPassword: $('#cpNew', el).value }); close(); toast('Password changed.'); }
          catch (e) { toast(e.message, true); }
        };
      });
    };
    if ($('#secRecovery')) $('#secRecovery').onclick = async () => {
      const r = await passwordPrompt('New recovery code', 'Enter your password to create a new recovery code. Your old code will stop working.', 'Create code');
      if (!r) return;
      try { const x = await call('POST', '/auth/recovery', { password: r.password }); root.account.hasRecovery = true; await api.save(root); showRecoveryCode(x.recoveryCode, () => render()); }
      catch (e) { toast(e.message, true); }
    };
    if ($('#secDelete')) $('#secDelete').onclick = deleteAccountFlow;
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

  // ---------------- First launch: welcome & setup ----------------
  const CURRENCIES = [['USD', '$'], ['EUR', '€'], ['GBP', '£'], ['AED', 'AED '], ['SAR', 'SAR '], ['CAD', 'C$'], ['AUD', 'A$']];
  const WALLET_CHOICES = ['Cash', 'Bank card', 'Whish Money', 'OMT Pay', 'Savings account', 'Credit card'];

  function needsOnboarding() {
    if (root.device.onboarded) return false;
    const hasData = Object.values(root.books).some((b) => (b.incomes || []).length || (b.transactions || []).length) || !!root.account;
    if (hasData) { root.device.onboarded = true; api.save(root); return false; }
    return true;
  }

  function onboarding() {
    return new Promise((resolve) => {
      const host = $('#onboardRoot');
      const ob = { step: 0, name: '', cur: 'USD', lira: false, rate: 89500, wallets: ['Cash', 'Bank card'], tpl: 'balanced', mode: 'new' };
      const finish = async (opts) => {
        if (!(opts && opts.keepBook)) {
          const st = L.defaultState();
          st.settings.userName = ob.name.trim();
          const c = CURRENCIES.find((x) => x[0] === ob.cur) || CURRENCIES[0];
          st.settings.currency = c[0]; st.settings.currencySymbol = c[1];
          st.settings.lbpRate = ob.lira ? Math.max(1, num(ob.rate) || 89500) : 89500;
          st.settings.wallets = (ob.wallets.length ? ob.wallets : ['Cash']).map((n, i) => ({ id: 'w_' + i + '_' + n.toLowerCase().replace(/[^a-z0-9]+/g, ''), name: n, opening: 0 }));
          st.sections = L.templateSections(ob.tpl);
          st.planUpdatedAt = st.settingsUpdatedAt = Date.now();
          L.DEVICE_KEYS.forEach((k) => { st.settings[k] = root.device[k]; });
          root.books.local = st; useBook('local');
        }
        root.device.onboarded = true; await api.save(root);
        if (opts && opts.keepAfter) { applyTheme(); render(); resolve(null); return; }
        host.classList.add('closing');
        setTimeout(() => { host.innerHTML = ''; host.classList.remove('closing'); resolve(opts && opts.goto); }, 300);
      };
      const STEPS = ['welcome', 'you', 'wallets', 'plan', 'account', 'done'];
      const draw = () => {
        const key = ob.mode === 'login' ? 'login' : STEPS[ob.step];
        const dots = ob.mode === 'login' ? '' : `<div class="ob-dots">${STEPS.slice(1, 5).map((_, i) => `<i class="${i + 1 <= ob.step ? 'on' : ''}"></i>`).join('')}</div>`;
        const logoHtml = $('.brand .logo').innerHTML;
        const body = {
          welcome: () => `<div class="ob-logo">${logoHtml}</div>
            <h1>Welcome to Leon's Ledger</h1>
            <p class="muted">Split every paycheck automatically, see where your money goes, and get advice from a built-in AI.</p>
            <div class="ob-feats">
              <div><span>%</span><b>Auto-split income</b><small>Every payment divided into your buckets.</small></div>
              <div><span>✦</span><b>AI advisor</b><small>Advice based on your real numbers.</small></div>
              <div><span>👥</span><b>Budget together</b><small>Share a budget with a partner or team.</small></div>
            </div>
            <button class="btn primary ob-main" data-next>Get started</button>
            <button class="btn ghost ob-main" data-login>I already have an account</button>
            <p class="muted small ob-legal">By continuing you agree to the <a href="${TERMS_URL}" target="_blank" rel="noopener">Terms</a> and <a href="${PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a>.</p>`,
          you: () => `<h2>About you</h2><p class="muted">This makes the app and its AI advice feel like yours.</p>
            <label class="f">Your first name<input id="obName" value="${esc(ob.name)}" placeholder="e.g. Leon" autocomplete="given-name"></label>
            <label class="f mt">Main currency<select id="obCur">${CURRENCIES.map(([c]) => `<option ${c === ob.cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
            <label class="row small mt"><input type="checkbox" id="obLira" ${ob.lira ? 'checked' : ''}> I also pay in Lebanese lira (LBP)</label>
            <label class="f mt-s ${ob.lira ? '' : 'hidden'}" id="obRateBox">LBP per 1 ${esc(ob.cur)}<input id="obRate" inputmode="numeric" value="${ob.rate}"></label>`,
          wallets: () => `<h2>Where's your money?</h2><p class="muted">Pick the places you pay from. You can add or rename them later.</p>
            <div class="ob-chips">${[...new Set([...WALLET_CHOICES, ...ob.wallets])].map((w) => `<button class="ob-chip ${ob.wallets.includes(w) ? 'on' : ''}" data-w="${esc(w)}">${ob.wallets.includes(w) ? '✓ ' : ''}${esc(w)}</button>`).join('')}</div>
            <div class="chat-row mt"><input id="obNewW" placeholder="Add another (e.g. My bank)"><button class="btn" id="obAddW">Add</button></div>`,
          plan: () => `<h2>How should your income split?</h2><p class="muted">Choose a starting plan — every percentage can be changed later.</p>
            <div class="ob-plans">${Object.entries(L.TEMPLATES).map(([k, t]) => `<button class="ob-plan ${k === ob.tpl ? 'on' : ''}" data-tpl="${k}">
              <div class="row between"><b>${esc(t.name)}</b><span class="tag">${esc(t.tag)}</span></div>
              <small class="muted">${esc(t.desc)}</small>
              <div class="split-bar mt-s">${t.sections.map((x, i) => `<i style="width:${x[2]}%;background:${L.PALETTE[i]}"></i>`).join('')}</div>
              <div class="legend" style="margin-top:6px">${t.sections.map((x, i) => `<span><b style="background:${L.PALETTE[i]}"></b>${esc(x[0])} ${x[2]}%</span>`).join('')}</div></button>`).join('')}</div>`,
          account: () => `<h2>Sync & share <span class="tag">optional</span></h2>
            <p class="muted">A free account lets you use the app on your phone and computer, share budgets, and get more AI requests each day. Your PIN and private chats never leave your device.</p>
            <label class="f">Username<input id="obUser" autocomplete="username" placeholder="e.g. leon"></label>
            <label class="f mt-s">Password<input id="obPass" type="password" autocomplete="new-password" placeholder="8+ characters"></label>
            <button class="btn primary ob-main mt" id="obCreate">Create my account</button>
            <button class="btn ghost ob-main" data-next>Skip for now</button>`,
          done: () => `<div class="ob-logo">${logoHtml}</div><h1>You're all set${ob.name ? ', ' + esc(ob.name.trim()) : ''}!</h1>
            <p class="muted">Start by logging your next paycheck — it will be split into your buckets automatically.</p>
            <button class="btn primary ob-main" data-finish="income">Log my first income</button>
            <button class="btn ghost ob-main" data-finish="dashboard">Explore the app</button>`,
          login: () => `<h2>Welcome back</h2><p class="muted">Log in to bring your synced budgets to this device.</p>
            <label class="f">Username<input id="obLUser" autocomplete="username"></label>
            <label class="f mt-s">Password<input id="obLPass" type="password" autocomplete="current-password"></label>
            <button class="btn primary ob-main mt" id="obLogin">Log in</button>
            <div class="row between mt-s"><a href="#" data-back-new class="small">← Back</a><a href="#" id="obForgot" class="small">Forgot password?</a></div>`
        }[key]();
        const nav = ['you', 'wallets', 'plan'].includes(key) ? `<div class="row between ob-nav"><button class="btn ghost" data-back>Back</button><button class="btn primary" data-next>Continue</button></div>` : '';
        host.innerHTML = `<div class="ob-screen"><div class="ob-card" data-step="${key}">${dots}${body}${nav}</div></div>`;
        bind(key);
      };
      const save = () => {
        if ($('#obName')) ob.name = $('#obName').value;
        if ($('#obCur')) ob.cur = $('#obCur').value;
        if ($('#obLira')) ob.lira = $('#obLira').checked;
        if ($('#obRate')) ob.rate = $('#obRate').value;
      };
      const bind = (key) => {
        $$('[data-next]', host).forEach((b) => (b.onclick = () => { save(); ob.step = Math.min(STEPS.length - 1, ob.step + 1); draw(); }));
        $$('[data-back]', host).forEach((b) => (b.onclick = () => { save(); ob.step = Math.max(0, ob.step - 1); draw(); }));
        $$('[data-finish]', host).forEach((b) => (b.onclick = () => finish({ goto: b.dataset.finish })));
        if ($('[data-login]', host)) $('[data-login]', host).onclick = () => { ob.mode = 'login'; draw(); };
        if ($('[data-back-new]', host)) $('[data-back-new]', host).onclick = (e) => { e.preventDefault(); ob.mode = 'new'; draw(); };
        if ($('#obLira')) $('#obLira').onchange = (e) => { $('#obRateBox').classList.toggle('hidden', !e.target.checked); };
        if ($('#obCur')) $('#obCur').onchange = () => { save(); draw(); };
        $$('[data-w]', host).forEach((b) => (b.onclick = () => { const w = b.dataset.w; ob.wallets = ob.wallets.includes(w) ? ob.wallets.filter((x) => x !== w) : [...ob.wallets, w]; draw(); }));
        if ($('#obAddW')) $('#obAddW').onclick = () => { const v = $('#obNewW').value.trim(); if (v && !ob.wallets.includes(v)) ob.wallets.push(v); draw(); };
        $$('[data-tpl]', host).forEach((b) => (b.onclick = () => { ob.tpl = b.dataset.tpl; draw(); }));
        if ($('#obCreate')) $('#obCreate').onclick = async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await call('POST', '/auth/signup', { username: $('#obUser').value.trim(), password: $('#obPass').value });
            root.account = { token: r.token, username: r.user.username, id: r.user.id, hasRecovery: true };
            await api.save(root);
            await finish({ goto: null, keepAfter: true });     // creates the budget from the choices
            const meta = root.meta.local;
            try { const b = await call('POST', '/books', { name: 'My budget', shared: false, data: L.forUpload(state) }); Object.assign(meta, { remoteId: b.id, rev: b.rev }); await api.save(root); } catch (_) {}
            host.innerHTML = '';
            showRecoveryCode(r.recoveryCode, () => { onboardingDone(); });
          } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
        };
        if ($('#obLogin')) $('#obLogin').onclick = async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await call('POST', '/auth/login', { username: $('#obLUser').value.trim(), password: $('#obLPass').value });
            root.account = { token: r.token, username: r.user.username, id: r.user.id }; await api.save(root);
            await refreshRemoteBooks();
            const mine = (remoteBooks || []).find((b) => !b.shared && b.role === 'owner');
            await finish({ keepBook: true, goto: 'dashboard' });
            if (mine) await linkRemote(mine);
            toast('Welcome back' + (r.user.username ? ', ' + nice(r.user.username) : '') + '!');
          } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
        };
        if ($('#obForgot')) $('#obForgot').onclick = (e) => { e.preventDefault(); forgotPasswordDialog($('#obLUser').value.trim(), async () => {
          await refreshRemoteBooks(); const mine = (remoteBooks || []).find((b) => !b.shared && b.role === 'owner');
          await finish({ keepBook: true, goto: 'dashboard' }); if (mine) await linkRemote(mine); }); };
        const first = $('input', host); if (first && key !== 'wallets') setTimeout(() => first.focus(), 60);
      };
      // after creating an account inside onboarding, show the final screen
      const onboardingDone = () => {
        host.innerHTML = `<div class="ob-screen"><div class="ob-card"><div class="ob-logo">${$('.brand .logo').innerHTML}</div><h1>You're all set${ob.name ? ', ' + esc(ob.name.trim()) : ''}!</h1>
          <p class="muted">Your account is ready and your budget is syncing. Log in with the same account on your other devices.</p>
          <button class="btn primary ob-main" data-go2="income">Log my first income</button><button class="btn ghost ob-main" data-go2="dashboard">Explore the app</button></div></div>`;
        $$('[data-go2]', host).forEach((b) => (b.onclick = () => { host.innerHTML = ''; go(b.dataset.go2); syncActive(); }));
      };
      draw();
    });
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
  $('#navAdd').onclick = () => { closeDrawer(); openAddSheet(); };
  (async () => {
    loadRoot(await api.load());
    applyTheme();
    document.body.classList.toggle('sb-collapsed', !!root.device.sbCollapsed);
    if (state.settings.pinHash) await lockScreen();
    if (needsOnboarding()) {
      await discover();                       // so account creation/login works during setup
      render();
      const target = await onboarding();
      if (target) page = target;
    }
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
