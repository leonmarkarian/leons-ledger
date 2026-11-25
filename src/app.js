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

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const m = (n) => L.money(n, state);
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const sym = () => esc(state.settings.currencySymbol || '$');

  async function persist() { await api.save(state); }

  function toast(text, isErr) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 5200);
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

  // ---------------- AI ----------------
  function systemPrompt() {
    return [
      "You are the built-in financial advisor inside Leon's Ledger, a personal budgeting app. The user is Leon.",
      'You see his split plan (sections and categories with percentages), current balances, debts, goals and recent activity.',
      'Give practical, specific, encouraging but honest advice in plain language. Use his real numbers. Keep it concise:',
      'short paragraphs or a few bullet points, no tables, no markdown headers. Suggest concrete amounts or percentage changes when useful.',
      'You are not a licensed financial advisor: do not recommend specific stocks, coins or trades; talk about strategy (debt payoff order, emergency fund, diversification, savings rate, goal timelines).'
    ].join(' ');
  }

  async function askAdvisor(messages, focusIncome) {
    const s = state.settings;
    if (!s.aiEnabled || !s.apiKey) return { ok: false, offline: true, text: L.fallbackAdvice(state, focusIncome) };
    const context = L.summaryForAI(state, focusIncome);
    const msgs = messages.map((x) => ({ role: x.role, content: x.content }));
    msgs[0] = { role: msgs[0].role, content: `Here is my current financial picture:\n\n${context}\n\n---\n\n${msgs[0].content}` };
    const res = await api.askAI({ apiKey: s.apiKey, model: s.model, system: systemPrompt(), messages: msgs });
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

  // ---------------- Pages ----------------
  const pages = {
    dashboard() {
      const b = L.balances(state);
      const latest = state.incomes[state.incomes.length - 1];
      const recent = activity().slice(0, 6);
      return `
        <div class="row between"><div><h1>Dashboard</h1><p class="sub">Where your money is right now.</p></div>
          <div class="row"><button class="btn" data-go="spend">− Spend / Pay</button><button class="btn primary" data-go="income">＋ Log income</button></div></div>
        <div class="grid g3">
          <div class="card stat"><div class="label">Available across all buckets</div><div class="value ${b.totalAvailable < 0 ? 'bad' : ''}">${m(b.totalAvailable)}</div></div>
          <div class="card stat"><div class="label">Total income logged</div><div class="value good">${m(b.totalIncome)}</div><div class="muted small mt-s">${state.incomes.length} payment${state.incomes.length === 1 ? '' : 's'}</div></div>
          <div class="card stat"><div class="label">Spent & paid</div><div class="value">${m(b.totalSpent)}</div><div class="muted small mt-s">${state.transactions.length} entr${state.transactions.length === 1 ? 'y' : 'ies'}</div></div>
        </div>
        <div class="card mt"><div class="row between"><h2>Your split plan</h2><button class="btn sm ghost" data-go="plan">Edit plan</button></div>
          <div class="split-bar">${state.sections.map((s) => `<i style="width:${s.percent}%;background:${s.color}" title="${esc(s.name)} ${s.percent}%"></i>`).join('')}</div>
          <div class="legend">${state.sections.map((s) => `<span><b style="background:${s.color}"></b>${esc(s.name)} ${s.percent}%</span>`).join('')}</div>
        </div>
        ${latest ? `<div class="card advice-card mt"><div class="row between"><h2>✦ Advisor on your last income (${m(latest.amount)}, ${fmtDate(latest.date)})</h2>
            <button class="btn sm ghost" data-reask="${latest.id}" ${aiBusy ? 'disabled' : ''}>Refresh advice</button></div>
          <div class="advice">${aiBusy && !latest.advice ? '<span class="typing">Thinking about your money…</span>' : esc(latest.advice || 'No advice yet — click Refresh advice.')}</div>
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
            <label class="f">Amount received<div class="money-input" data-sym="${sym()}"><input class="big" id="incAmount" type="number" min="0" step="0.01" placeholder="0.00" autofocus></div></label>
            <div class="form-grid mt">
              <label class="f">Date<input id="incDate" type="date" value="${today()}"></label>
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
        <div class="tabs"><button data-tab="spend" class="${spendTab === 'spend' ? 'active' : ''}">Spend / Pay</button><button data-tab="transfer" class="${spendTab === 'transfer' ? 'active' : ''}">Move between buckets</button></div>
        ${spendTab === 'spend' ? spendForm() : transferForm()}
        ${lastPaymentMsg ? `<div class="card result-card mt">✓ ${esc(lastPaymentMsg)}</div>` : ''}`;
    },

    plan() {
      if (!draftPlan) draftPlan = JSON.parse(JSON.stringify(state.sections));
      const v = L.validatePlan(draftPlan);
      const types = Object.entries(L.SECTION_TYPES);
      return `<div class="sticky-bar"><div class="row between"><div><h1>Split plan</h1><p class="sub" style="margin:0">Sections get a % of each income; categories get a % of their section. Edit anything.</p></div>
          <div class="row"><button class="btn ghost" id="planReset">Discard changes</button><button class="btn" id="planAddSec">＋ Add section</button><button class="btn primary" id="planSave" ${v.ok ? '' : 'disabled'}>Save plan</button></div></div>
          <div class="row mt-s between"><div class="small">Sections total: <b class="${Math.abs(v.total - 100) < 0.001 ? 'good' : 'bad'}">${v.total}%</b></div>
          <div class="errors">${v.errors.map((e) => `<div>• ${esc(e)}</div>`).join('')}</div></div></div>
        ${draftPlan.map((s, si) => {
          const ct = L.round2(L.sum(s.categories, (c) => Number(c.percent) || 0));
          return `<div class="plan-sec" style="--c:${s.color}">
            <div class="plan-sec-head">
              <input type="color" value="${s.color}" data-s="${si}" data-k="color">
              <input value="${esc(s.name)}" data-s="${si}" data-k="name" placeholder="Section name">
              <select data-s="${si}" data-k="type">${types.map(([k, t]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
              <div class="pct-input"><input type="number" min="0" max="100" step="0.5" value="${s.percent}" data-s="${si}" data-k="percent"></div>
              <button class="icon-btn" data-delsec="${si}" title="Delete section">✕</button>
            </div>
            <div class="plan-cats">
              <div class="plan-cat small muted"><span>Category</span><span>% of section</span><span>${s.type === 'debt' ? 'Total owed' : 'Goal (optional)'}</span><span>Note</span><span></span></div>
              ${s.categories.map((c, ci) => `<div class="plan-cat">
                <input value="${esc(c.name)}" data-s="${si}" data-c="${ci}" data-k="name" placeholder="Category name">
                <div class="pct-input"><input type="number" min="0" max="100" step="0.5" value="${c.percent}" data-s="${si}" data-c="${ci}" data-k="percent"></div>
                <div class="money-input" data-sym="${sym()}"><input type="number" min="0" step="0.01" value="${c.target || ''}" placeholder="—" data-s="${si}" data-c="${ci}" data-k="target"></div>
                <input value="${esc(c.note || '')}" data-s="${si}" data-c="${ci}" data-k="note" placeholder="${s.type === 'debt' ? 'e.g. lender, due date, interest' : 'Optional'}">
                <button class="icon-btn" data-delcat="${si}|${ci}" title="Delete category">✕</button></div>`).join('')}
              <div class="row between"><button class="btn sm" data-addcat="${si}">＋ Add category</button>
                <span class="small">Categories total: <b class="${Math.abs(ct - 100) < 0.001 ? 'good' : 'bad'}">${ct}%</b>
                ${Math.abs(ct - 100) > 0.001 ? `<button class="btn sm ghost" data-even="${si}">Split evenly</button>` : ''}</span></div>
            </div></div>`;
        }).join('')}
        <p class="muted small">Changing the plan only affects future incomes. Past incomes keep the split they were saved with, so your history stays accurate.</p>`;
    },

    history() {
      const rows = activity().filter((r) => historyFilter === 'all' || r.kind === historyFilter);
      return `<h1>History</h1><p class="sub">Every income, payment and transfer. Click ✎ to edit or ✕ to delete.</p>
        <div class="tabs">${[['all', 'All'], ['income', 'Income'], ['spend', 'Spending & payments'], ['transfer', 'Transfers']].map(([k, l]) => `<button data-filter="${k}" class="${historyFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="card">${rows.length ? activityTable(rows, true) : '<div class="empty">Nothing here yet.</div>'}</div>`;
    },

    advisor() {
      const s = state.settings;
      const noKey = !s.apiKey || !s.aiEnabled;
      return `<h1>AI advisor</h1><p class="sub">Ask anything about your money. The advisor sees your plan, balances, debts, goals and recent activity.</p>
        ${noKey ? `<div class="card mt" style="border-color:rgba(242,180,91,.4)"><b class="warn">AI is off.</b> <span class="muted">Add your Anthropic API key in Settings to get personalised advice. Until then you'll get offline tips.</span> <button class="btn sm" data-go="settings">Open Settings</button></div>` : ''}
        <div class="card mt"><div class="chat" id="chat">
          ${state.chat.length ? state.chat.map((c) => `<div class="msg ${c.role}">${esc(c.content)}</div>`).join('') : `<div class="empty">Try: “How long until I can pay off my debts?” · “Should I move more to my wedding fund?” · “Review my spending this month.”</div>`}
          ${aiBusy ? '<div class="msg assistant typing">Thinking…</div>' : ''}
        </div>
        <div class="row mt"><input id="chatInput" style="flex:1" placeholder="Ask the advisor…" ${aiBusy ? 'disabled' : ''}><button class="btn primary" id="chatSend" ${aiBusy ? 'disabled' : ''}>Send</button>
          ${state.chat.length ? '<button class="btn ghost" id="chatClear">Clear</button>' : ''}</div></div>`;
    },

    settings() {
      const s = state.settings;
      return `<h1>Settings</h1><p class="sub">Everything is stored only on this computer.</p>
        <div class="grid g2">
          <div class="card"><h2>AI advisor</h2>
            <label class="row small"><input type="checkbox" id="sAi" ${s.aiEnabled ? 'checked' : ''}> Enable AI advisor</label>
            <label class="row small mt-s"><input type="checkbox" id="sAuto" ${s.autoAdviceOnIncome ? 'checked' : ''}> Give advice automatically every time I log income</label>
            <label class="f mt">Anthropic API key<input id="sKey" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-…"></label>
            <div class="small muted mt-s">Get one at console.anthropic.com → API Keys. It's stored locally and only sent to Anthropic.</div>
            <label class="f mt">Model<input id="sModel" value="${esc(s.model)}"></label>
            <label class="f mt">About me (the advisor uses this for context)<textarea id="sAbout" rows="5">${esc(s.aboutMe)}</textarea></label>
          </div>
          <div>
            <div class="card"><h2>General</h2>
              <div class="form-grid">
                <label class="f">Currency code<input id="sCur" value="${esc(s.currency)}"></label>
                <label class="f">Currency symbol<input id="sSym" value="${esc(s.currencySymbol)}"></label>
                <label class="f full">Payment methods (comma-separated)<input id="sMethods" value="${esc(s.paymentMethods.join(', '))}"></label>
              </div>
              <button class="btn primary mt" id="sSave">Save settings</button>
            </div>
            <div class="card mt"><h2>Backup</h2>
              <p class="muted small" style="margin-top:0">Your data lives in your Windows user folder and survives updates. Export a backup now and then anyway.</p>
              <div class="row wrap"><button class="btn" id="bExport">Export backup</button><button class="btn" id="bImport">Import backup</button><button class="btn ghost" id="bFolder">Open data folder</button></div>
              <button class="btn danger ghost mt" id="bReset">Reset everything…</button>
            </div>
            <div class="card mt"><h2>Updates</h2>
              <p class="muted small" style="margin-top:0" id="updText">Version <span id="verText"></span>. The app checks for updates automatically on launch.</p>
              <button class="btn" id="uCheck">Check for updates</button>
            </div>
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
    state.incomes.forEach((i) => rows.push({ kind: 'income', id: i.id, at: i.createdAt || 0, date: i.date, amount: i.amount, what: i.source || 'Income', note: i.note, detail: 'Split across your plan' }));
    state.transactions.forEach((t) => rows.push({ kind: 'spend', id: t.id, at: t.createdAt || 0, date: t.date, amount: -t.amount, what: name(t.sectionId, t.categoryId), note: t.note, detail: t.method || '' }));
    state.transfers.forEach((t) => rows.push({ kind: 'transfer', id: t.id, at: t.createdAt || 0, date: t.date, amount: t.amount, what: `${name(t.from.sectionId, t.from.categoryId)}  ⇢  ${name(t.to.sectionId, t.to.categoryId)}`, note: t.note, detail: '' }));
    return rows.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);
  }

  function activityTable(rows, editable) {
    const pill = { income: '<span class="pill in">Income</span>', spend: '<span class="pill out">Paid</span>', transfer: '<span class="pill tr">Moved</span>' };
    return `<table><thead><tr><th>Date</th><th>Type</th><th>What</th><th>Note</th><th class="num">Amount</th>${editable ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="muted">${fmtDate(r.date)}</td><td>${pill[r.kind]}</td><td>${esc(r.what)}${r.detail ? `<div class="muted small">${esc(r.detail)}</div>` : ''}</td>
        <td class="muted">${esc(r.note || '')}</td><td class="num ${r.kind === 'income' ? 'good' : r.kind === 'spend' ? 'bad' : ''}">${r.kind === 'income' ? '+' : ''}${m(r.amount)}</td>
        ${editable ? `<td class="num" style="white-space:nowrap"><button class="icon-btn" data-edit="${r.kind}|${r.id}" title="Edit">✎</button><button class="icon-btn" data-del="${r.kind}|${r.id}" title="Delete">✕</button></td>` : ''}</tr>`).join('')}
    </tbody></table>`;
  }

  function incomeOverrides() {
    if (!$('#incCustom') || !$('#incCustom').checked) return null;
    const o = {};
    $$('[data-ov]').forEach((el) => { o[el.dataset.ov] = Number(el.value) || 0; });
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
          ${custom ? `<div class="pct-input" style="width:90px"><input type="number" min="0" max="100" step="0.5" data-ov="${s.id}" value="${sa.percent}"></div>` : `<span class="muted small">${sa.percent}%</span>`}</div>
          <b>${m(sa.amount)}</b></div>
        <div class="muted small mt-s">${s.categories.map((c) => { const a = split.allocations.find((x) => x.categoryId === c.id); return `${esc(c.name)} ${m(a.amount)}`; }).join(' · ')}</div></div>`;
    }).join('')}
    ${custom ? `<div class="small mt-s">Total: <b class="${Math.abs(total - 100) < 0.001 ? 'good' : 'bad'}">${total}%</b></div>` : ''}`;
  }

  function lastIncomeAdviceHtml() {
    const inc = state.incomes.find((i) => i.id === lastIncomeId);
    if (!inc) return '';
    return `<div class="card advice-card mt"><h2>✦ Advisor's take on ${m(inc.amount)}</h2>
      <div class="advice">${aiBusy && !inc.advice ? '<span class="typing">Thinking about this income…</span>' : esc(inc.advice || '')}</div></div>`;
  }

  function spendForm() {
    const methods = state.settings.paymentMethods;
    return `<div class="grid g12"><div class="card">
      <label class="f">Which bucket is this from?<select id="spCat">${categoryOptions(spendForm.last)}</select></label>
      <div id="spAvail" class="small muted mt-s"></div>
      <label class="f mt">Amount<div class="money-input" data-sym="${sym()}"><input class="big" id="spAmount" type="number" min="0" step="0.01" placeholder="0.00"></div></label>
      <div class="form-grid mt">
        <label class="f">Date<input id="spDate" type="date" value="${today()}"></label>
        <label class="f">Paid with<select id="spMethod">${methods.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
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
        <label class="f">Amount<div class="money-input" data-sym="${sym()}"><input id="trAmount" type="number" min="0" step="0.01" placeholder="0.00"></div></label>
        <label class="f">Date<input id="trDate" type="date" value="${today()}"></label>
        <label class="f full">Note<input id="trNote" placeholder="Optional"></label>
      </div>
      <button class="btn primary mt" id="trSave">Move money</button></div>`;
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
  function render() {
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
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
  }

  function bind() {
    $$('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    const handlers = { dashboard: bindDashboard, income: bindIncome, spend: bindSpend, plan: bindPlan, history: bindHistory, advisor: bindAdvisor, settings: bindSettings };
    handlers[page]();
  }

  function bindDashboard() {
    $$('[data-reask]').forEach((b) => (b.onclick = () => { const inc = state.incomes.find((i) => i.id === b.dataset.reask); if (inc) adviseOnIncome(inc); }));
  }

  function bindIncome() {
    const refresh = () => { $('#incPreview').innerHTML = incomePreviewHtml(Number($('#incAmount').value), incomeOverrides()); bindOverrides(); };
    const bindOverrides = () => $$('[data-ov]').forEach((el) => (el.oninput = () => {
      const o = incomeOverrides(); const pos = el.dataset.ov;
      $('#incPreview').innerHTML = incomePreviewHtml(Number($('#incAmount').value), o); bindOverrides();
      const again = $(`[data-ov="${pos}"]`); if (again) { again.focus(); const v = again.value; again.value = ''; again.value = v; }
    }));
    $('#incAmount').oninput = refresh;
    $('#incCustom').onchange = refresh;
    $('#incSave').onclick = async () => {
      const amount = L.round2($('#incAmount').value);
      const err = $('#incErr');
      if (!(amount > 0)) { err.textContent = 'Enter an amount greater than zero.'; return; }
      const v = L.validatePlan(state.sections);
      if (!v.ok) { err.innerHTML = 'Your split plan needs fixing first: ' + esc(v.errors[0]); return; }
      const ov = incomeOverrides();
      if (ov) { const t = L.round2(L.sum(Object.values(ov))); if (Math.abs(t - 100) > 0.001) { err.textContent = `Section percentages add up to ${t}% — they need to total 100%.`; return; } }
      const split = L.splitIncome(amount, state.sections, ov);
      const income = { id: L.uid('inc'), createdAt: Date.now(), date: $('#incDate').value || today(), amount, source: $('#incSource').value.trim(), note: $('#incNote').value.trim(), allocations: split.allocations, advice: '' };
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
      $('#spSave').onclick = async () => {
        const amount = L.round2($('#spAmount').value);
        if (!(amount > 0)) return toast('Enter an amount greater than zero.', true);
        const [sectionId, categoryId] = $('#spCat').value.split('|');
        const tx = { id: L.uid('tx'), createdAt: Date.now(), date: $('#spDate').value || today(), sectionId, categoryId, amount, method: $('#spMethod').value, note: $('#spNote').value.trim() };
        state.transactions.push(tx);
        await persist();
        lastPaymentMsg = L.paymentMessage(state, tx);
        render();
      };
    } else {
      $('#trSave').onclick = async () => {
        const amount = L.round2($('#trAmount').value);
        if (!(amount > 0)) return toast('Enter an amount greater than zero.', true);
        if ($('#trFrom').value === $('#trTo').value) return toast('Pick two different buckets.', true);
        const [fs, fc] = $('#trFrom').value.split('|'); const [ts, tc] = $('#trTo').value.split('|');
        state.transfers.push({ id: L.uid('tr'), createdAt: Date.now(), date: $('#trDate').value || today(), from: { sectionId: fs, categoryId: fc }, to: { sectionId: ts, categoryId: tc }, amount, note: $('#trNote').value.trim() });
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
        target[k] = ['percent', 'target'].includes(k) ? (el.value === '' ? 0 : Number(el.value)) : el.value;
        if (k === 'percent' || k === 'color' || k === 'type') {
          const id = el.dataset.s + '-' + (el.dataset.c || '') + '-' + k;
          rerender();
          const again = $$('[data-k]').find((x) => x.dataset.s + '-' + (x.dataset.c || '') + '-' + x.dataset.k === id);
          if (again && k === 'percent') { again.focus(); }
        }
      });
    });
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
      await persist(); toast('Plan saved. New incomes will use it.'); draftPlan = null; rerender();
    };
  }

  function hasHistory(sid, cid) {
    return state.incomes.some((i) => i.allocations.some((a) => a.categoryId === cid && a.amount)) ||
      state.transactions.some((t) => t.categoryId === cid) || state.transfers.some((t) => t.from.categoryId === cid || t.to.categoryId === cid);
  }

  function bindHistory() {
    $$('[data-filter]').forEach((b) => (b.onclick = () => { historyFilter = b.dataset.filter; render(); }));
    const listOf = { income: 'incomes', spend: 'transactions', transfer: 'transfers' };
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const [kind, id] = b.dataset.del.split('|');
      const msg = kind === 'income' ? 'Deleting an income also removes the money it added to every bucket.' : 'This entry will be removed and the bucket balance restored.';
      if (!(await confirmBox('Delete entry?', msg, 'Delete'))) return;
      state[listOf[kind]] = state[listOf[kind]].filter((x) => x.id !== id);
      await persist(); render();
    }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => {
      const [kind, id] = b.dataset.edit.split('|');
      const item = state[listOf[kind]].find((x) => x.id === id);
      modal(`<h2>Edit ${kind === 'spend' ? 'payment' : kind}</h2>
        <div class="form-grid">
          <label class="f">Amount<input id="eAmount" type="number" step="0.01" value="${item.amount}"></label>
          <label class="f">Date<input id="eDate" type="date" value="${item.date.slice(0, 10)}"></label>
          ${kind === 'spend' ? `<label class="f full">Bucket<select id="eCat">${categoryOptions(item.sectionId + '|' + item.categoryId)}</select></label>
            <label class="f">Paid with<select id="eMethod">${state.settings.paymentMethods.map((x) => `<option ${x === item.method ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>` : ''}
          ${kind === 'income' ? `<label class="f">Source<input id="eSource" value="${esc(item.source || '')}"></label>` : ''}
          <label class="f full">Note<input id="eNote" value="${esc(item.note || '')}"></label>
        </div>
        ${kind === 'income' ? '<p class="muted small">Changing the amount re-splits it using the same proportions it was originally split with.</p>' : ''}
        <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
      (el, close) => {
        $('[data-x]', el).onclick = close;
        $('[data-ok]', el).onclick = async () => {
          const amount = L.round2($('#eAmount', el).value);
          if (!(amount > 0)) return toast('Amount must be greater than zero.', true);
          if (kind === 'income' && amount !== item.amount) {
            const parts = L.distribute(amount, item.allocations.map((a) => a.amount || 0.0001));
            item.allocations.forEach((a, i) => (a.amount = parts[i]));
          }
          item.amount = amount; item.date = $('#eDate', el).value || item.date; item.note = $('#eNote', el).value.trim();
          if (kind === 'spend') { const [s, c] = $('#eCat', el).value.split('|'); item.sectionId = s; item.categoryId = c; item.method = $('#eMethod', el).value; }
          if (kind === 'income') item.source = $('#eSource', el).value.trim();
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
      s.apiKey = $('#sKey').value.trim(); s.model = $('#sModel').value.trim() || 'claude-sonnet-5-5';
      s.aboutMe = $('#sAbout').value.trim(); s.currency = $('#sCur').value.trim() || 'USD'; s.currencySymbol = $('#sSym').value || '$';
      const methods = $('#sMethods').value.split(',').map((x) => x.trim()).filter(Boolean);
      s.paymentMethods = methods.length ? methods : ['Cash'];
      await persist(); toast('Settings saved.');
    };
    $('#bExport').onclick = async () => { const p = await api.exportData(state); if (p) toast('Backup saved to ' + p); };
    $('#bImport').onclick = async () => {
      const data = await api.importData(); if (!data) return;
      if (!(await confirmBox('Import backup?', 'This replaces all current data with the backup. Your API key is kept.', 'Import'))) return;
      const key = state.settings.apiKey; state = L.migrate(data); state.settings.apiKey = state.settings.apiKey || key;
      await persist(); toast('Backup imported.'); render();
    };
    $('#bFolder').onclick = () => api.openDataFolder();
    $('#bReset').onclick = async () => {
      if (!(await confirmBox('Reset everything?', 'This deletes all incomes, payments and your plan, and restores the default setup. Export a backup first if you might want it back. This cannot be undone.', 'Reset'))) return;
      const key = state.settings.apiKey; state = L.defaultState(); state.settings.apiKey = key;
      await persist(); toast('Reset done.'); render();
    };
    $('#uCheck').onclick = () => { manualUpdateCheck = true; api.checkUpdates(); };
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

  // ---------------- Boot ----------------
  $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.page)));
  (async () => {
    state = L.migrate(await api.load());
    await persist();
    const v = await api.version();
    $('#versionLabel').textContent = 'v' + v;
    render();
  })();
})();
