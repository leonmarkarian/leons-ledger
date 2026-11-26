/* Leon's Ledger — core budgeting logic.
   Pure functions, no DOM. Used by the renderer (window.Ledger) and by Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  const SECTION_TYPES = {
    spend:  { label: 'Spending',   verb: 'spent on',       past: 'Spent' },
    save:   { label: 'Savings',    verb: 'moved out of',   past: 'Withdrawn' },
    debt:   { label: 'Debt',       verb: 'paid for',       past: 'Paid' },
    invest: { label: 'Investment', verb: 'invested in',    past: 'Invested' },
    business: { label: 'Business', verb: 'spent from',   past: 'Spent' },
    other:  { label: 'Other',      verb: 'used from',      past: 'Used' }
  };

  const PALETTE = ['#7c9cff', '#5fd3a7', '#f2b45b', '#f07a8a', '#b48cf2', '#5cc6e8', '#e8d35c', '#9aa5b8'];

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);

  function cat(name, percent, extra) {
    return Object.assign({ id: uid('cat'), name, percent, target: 0, note: '' }, extra || {});
  }

  // Ready-made split plans offered on first launch (and as the default for new budgets)
  const TEMPLATES = {
    balanced: { name: 'Balanced', tag: '50 / 30 / 20', desc: 'Needs, wants and savings — the classic rule.', sections: [
      ['Needs', 'spend', 50, [['Rent & bills', 45], ['Food & groceries', 35], ['Transport', 20]]],
      ['Wants', 'spend', 30, [['Going out', 40], ['Shopping', 35], ['Subscriptions', 25]]],
      ['Savings', 'save', 15, [['Emergency fund', 60, 3000], ['Goals', 40]]],
      ['Debt', 'debt', 5, [['Debt payments', 100]]]] },
    saver: { name: 'Saver', tag: 'Save 35%', desc: 'Grow savings and investments faster.', sections: [
      ['Needs', 'spend', 50, [['Rent & bills', 45], ['Food & groceries', 35], ['Transport', 20]]],
      ['Wants', 'spend', 15, [['Going out', 50], ['Shopping', 50]]],
      ['Savings', 'save', 25, [['Emergency fund', 50, 5000], ['Goals', 50]]],
      ['Investments', 'invest', 10, [['Long-term', 100]]]] },
    debt: { name: 'Debt crusher', tag: '30% to debt', desc: 'Pay debts off as fast as possible.', sections: [
      ['Needs', 'spend', 50, [['Rent & bills', 45], ['Food & groceries', 35], ['Transport', 20]]],
      ['Wants', 'spend', 10, [['Fun money', 100]]],
      ['Debt', 'debt', 30, [['Debt payments', 100]]],
      ['Emergency', 'save', 10, [['Emergency fund', 100, 2000]]]] },
    accounts: { name: 'Five accounts', tag: 'Allowance + 4', desc: 'Allowance, savings, emergency, debt & investing.', sections: [
      ['Allowance', 'spend', 40, [['Daily spending', 60], ['Personal', 40]]],
      ['Savings', 'save', 20, [['Big goals', 100]]],
      ['Emergency', 'save', 10, [['6-month buffer', 100, 4500]]],
      ['Debts', 'debt', 15, [['Debt payments', 100]]],
      ['Investments', 'invest', 15, [['Long-term', 70], ['Short-term', 30]]]] }
  };
  function templateSections(key) {
    const t = TEMPLATES[key] || TEMPLATES.balanced;
    return t.sections.map(([name, type, percent, cats], i) => ({ id: uid('sec'), name, type, percent, color: PALETTE[i % PALETTE.length],
      categories: cats.map(([n, pc, target]) => cat(n, pc, { target: target || 0 })) }));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        currency: 'USD',
        currencySymbol: '$',
        apiKey: '',
        model: 'claude-haiku-5-5',
        theme: 'black',
        pinHash: '',
        lbpRate: 89500,
        wallets: [{ id: 'w_cash', name: 'Cash', opening: 0 }, { id: 'w_card', name: 'Bank card', opening: 0 }],
        aiEnabled: true,
        autoAdviceOnIncome: true,
        paymentMethods: ['Cash', 'Wish Money card'],
        aboutMe: ''
      },
      sections: templateSections('balanced'),
      incomes: [],       // {id,date,amount,source,note,allocations:[{sectionId,categoryId,amount}],advice}
      transactions: [],  // {id,date,sectionId,categoryId,amount,method,note}
      transfers: [],     // {id,date,from:{sectionId,categoryId},to:{...},amount,note}
      walletTransfers: [], // {id,date,fromWalletId,toWalletId,amount,note}
      recurring: [],     // {id,name,amount,sectionId,categoryId,walletId,day,auto,lastLogged:'YYYY-MM'}
      monthlyReports: [],// {month:'YYYY-MM', text, date}
      chat: []           // {role:'user'|'assistant', content, date}
    };
  }

  /** Bring an older / partial state up to the current shape without losing data. */
  function migrate(state) {
    const base = defaultState();
    if (!state || typeof state !== 'object') return base;
    const s = Object.assign({}, base, state);
    s.settings = Object.assign({}, base.settings, state.settings || {});
    ['incomes', 'transactions', 'transfers', 'walletTransfers', 'recurring', 'monthlyReports', 'chat'].forEach((k) => { if (!Array.isArray(s[k])) s[k] = []; });
    if (!s.deleted || typeof s.deleted !== 'object') s.deleted = {};
    // wallets: older versions only had a list of payment-method names
    if (!Array.isArray(state.settings && state.settings.wallets) || !state.settings.wallets.length) {
      const names = (state.settings && state.settings.paymentMethods) || ['Cash', 'Wish Money card'];
      s.settings.wallets = names.map((n, i) => ({ id: 'w_' + i + '_' + String(n).toLowerCase().replace(/[^a-z0-9]+/g, ''), name: n, opening: 0 }));
    }
    const wByName = {}; s.settings.wallets.forEach((w) => { wByName[w.name] = w.id; });
    s.transactions.forEach((t) => { if (!t.walletId) t.walletId = wByName[t.method] || s.settings.wallets[0].id; });
    s.incomes.forEach((i) => { if (!i.walletId) i.walletId = s.settings.wallets[0].id; });
    if (s.settings.model === 'claude-sonnet-5-5' && !(state.settings && state.settings.modelChosen)) s.settings.model = 'claude-haiku-5-5';
    s.settings.lbpRate = Number(s.settings.lbpRate) || 89500;
    if (!Array.isArray(s.sections) || !s.sections.length) s.sections = base.sections;
    s.sections.forEach((sec, i) => {
      sec.id = sec.id || uid('sec');
      sec.type = SECTION_TYPES[sec.type] ? sec.type : 'other';
      if (sec.type === 'other' && /^business$/i.test(sec.name || '')) sec.type = 'business';
      sec.color = sec.color || PALETTE[i % PALETTE.length];
      sec.percent = Number(sec.percent) || 0;
      sec.categories = Array.isArray(sec.categories) && sec.categories.length ? sec.categories : [cat('General', 100)];
      sec.categories.forEach((c) => {
        c.id = c.id || uid('cat');
        c.percent = Number(c.percent) || 0;
        c.target = Number(c.target) || 0;
        c.note = c.note || '';
        c.apr = Number(c.apr) || 0;
        c.minPayment = Number(c.minPayment) || 0;
      });
    });
    s.schemaVersion = SCHEMA_VERSION;
    return s;
  }

  /** Check that section %s total 100 and each section's category %s total 100. */
  function validatePlan(sections) {
    const errors = [];
    const total = round2(sum(sections, (s) => Number(s.percent) || 0));
    if (Math.abs(total - 100) > 0.001) errors.push(`Buckets add up to ${total}% — they need to total 100%.`);
    sections.forEach((s) => {
      if (!s.categories.length) { errors.push(`"${s.name}" has no categories.`); return; }
      const t = round2(sum(s.categories, (c) => Number(c.percent) || 0));
      if (Math.abs(t - 100) > 0.001) errors.push(`Categories in "${s.name}" add up to ${t}% — they need to total 100%.`);
    });
    return { ok: errors.length === 0, errors, total };
  }

  /** Distribute `amount` into cents across weights, so the parts always add up exactly. */
  function distribute(amount, weights) {
    const cents = Math.round(amount * 100);
    const wsum = sum(weights) || 1;
    const raw = weights.map((w) => (cents * w) / wsum);
    const floors = raw.map(Math.floor);
    let left = cents - sum(floors);
    const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; left > 0 && k < order.length; k++, left--) floors[order[k][1]]++;
    return floors.map((c) => c / 100);
  }

  /** Split an income according to a plan. Optional `sectionOverrides` = {sectionId: percent} for a one-off split. */
  function splitIncome(amount, sections, sectionOverrides) {
    amount = round2(amount);
    const pct = sections.map((s) => (sectionOverrides && sectionOverrides[s.id] != null ? Number(sectionOverrides[s.id]) : Number(s.percent)) || 0);
    const secAmounts = distribute(amount, pct);
    const allocations = [];
    sections.forEach((s, i) => {
      const catAmounts = distribute(secAmounts[i], s.categories.map((c) => Number(c.percent) || 0));
      s.categories.forEach((c, j) => allocations.push({ sectionId: s.id, categoryId: c.id, amount: catAmounts[j] }));
    });
    return { allocations, sectionAmounts: sections.map((s, i) => ({ sectionId: s.id, amount: secAmounts[i], percent: pct[i] })) };
  }

  function findCategory(state, sectionId, categoryId) {
    const section = state.sections.find((s) => s.id === sectionId);
    const category = section && section.categories.find((c) => c.id === categoryId);
    return { section, category };
  }

  /** Balance for every category: allocated, spent, transfers, available; plus target progress. */
  function balances(state) {
    const map = {};
    const key = (a, b) => a + '|' + b;
    state.sections.forEach((s) => s.categories.forEach((c) => {
      map[key(s.id, c.id)] = { sectionId: s.id, categoryId: c.id, allocated: 0, spent: 0, transferIn: 0, transferOut: 0, available: 0, paidTotal: 0 };
    }));
    const get = (sid, cid) => map[key(sid, cid)];
    state.incomes.forEach((inc) => (inc.allocations || []).forEach((a) => { const b = get(a.sectionId, a.categoryId); if (b) b.allocated += a.amount; }));
    state.transactions.forEach((t) => { const b = get(t.sectionId, t.categoryId); if (b) b.spent += t.amount; });
    state.transfers.forEach((t) => {
      const f = get(t.from.sectionId, t.from.categoryId); if (f) f.transferOut += t.amount;
      const to = get(t.to.sectionId, t.to.categoryId); if (to) to.transferIn += t.amount;
    });
    Object.values(map).forEach((b) => {
      ['allocated', 'spent', 'transferIn', 'transferOut'].forEach((k) => { b[k] = round2(b[k]); });
      b.available = round2(b.allocated + b.transferIn - b.transferOut - b.spent);
      b.paidTotal = b.spent;
    });

    const sections = state.sections.map((s) => {
      const cats = s.categories.map((c) => {
        const b = get(s.id, c.id);
        const t = Number(c.target) || 0;
        let progress = null;
        if (t > 0) {
          if (s.type === 'debt') progress = { kind: 'debt', target: t, done: b.spent, remaining: round2(Math.max(0, t - b.spent)), pct: Math.min(100, (b.spent / t) * 100) };
          else progress = { kind: 'goal', target: t, done: Math.max(0, b.available), remaining: round2(Math.max(0, t - b.available)), pct: Math.min(100, (Math.max(0, b.available) / t) * 100) };
        }
        return Object.assign({ name: c.name, percent: c.percent, target: t, progress }, b);
      });
      return {
        id: s.id, name: s.name, type: s.type, color: s.color, percent: s.percent, categories: cats,
        allocated: round2(sum(cats, (c) => c.allocated)),
        spent: round2(sum(cats, (c) => c.spent)),
        available: round2(sum(cats, (c) => c.available))
      };
    });
    return {
      sections,
      get: (sid, cid) => get(sid, cid),
      totalIncome: round2(sum(state.incomes, (i) => i.amount)),
      totalSpent: round2(sum(state.transactions, (t) => t.amount)),
      totalAvailable: round2(sum(sections, (s) => s.available))
    };
  }

  function money(n, state) {
    const sym = (state && state.settings && state.settings.currencySymbol) || '$';
    const v = round2(n);
    const neg = v < 0;
    return (neg ? '-' : '') + sym + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Human sentence describing a payment, e.g. "$200.00 was paid for Car loan. $100.00 remaining in this budget." */
  function paymentMessage(state, tx) {
    const { section, category } = findCategory(state, tx.sectionId, tx.categoryId);
    if (!section || !category) return '';
    const b = balances(state).get(tx.sectionId, tx.categoryId);
    const type = SECTION_TYPES[section.type] || SECTION_TYPES.other;
    const lines = [`${money(tx.amount, state)} was ${type.verb} ${category.name}.`];
    if (b.available >= 0) lines.push(`${money(b.available, state)} remaining in the ${section.name} → ${category.name} budget.`);
    else lines.push(`Over budget by ${money(-b.available, state)} in ${section.name} → ${category.name}.`);
    if (section.type === 'debt' && category.target > 0) {
      const left = round2(category.target - b.spent);
      lines.push(left > 0 ? `${money(left, state)} still owed of ${money(category.target, state)}.` : `Debt fully paid off! 🎉`);
    }
    return lines.join(' ');
  }

  /** Compact plain-text picture of the finances for the AI advisor. */
  function summaryForAI(state, focusIncome) {
    const bal = balances(state);
    const m = (n) => money(n, state);
    const out = [];
    out.push(`Currency: ${state.settings.currency}. Today: ${new Date().toISOString().slice(0, 10)}.`);
    if (state.settings.aboutMe) out.push(`About the user: ${state.settings.aboutMe}`);
    out.push(`Totals: income logged ${m(bal.totalIncome)}, spent/paid ${m(bal.totalSpent)}, currently available across all buckets ${m(bal.totalAvailable)}.`);
    out.push('Plan and balances (section % of income → category % of section):');
    bal.sections.forEach((s) => {
      out.push(`- ${s.name} [${SECTION_TYPES[s.type].label}] ${s.percent}%: allocated ${m(s.allocated)}, ${SECTION_TYPES[s.type].past.toLowerCase()} ${m(s.spent)}, available ${m(s.available)}`);
      s.categories.forEach((c) => {
        let line = `   • ${c.name} ${c.percent}%: allocated ${m(c.allocated)}, used ${m(c.spent)}, available ${m(c.available)}`;
        if (c.progress) line += c.progress.kind === 'debt' ? `, debt total ${m(c.progress.target)} with ${m(c.progress.remaining)} still owed` : `, goal ${m(c.progress.target)} (${Math.round(c.progress.pct)}% reached)`;
        out.push(line);
      });
    });
    const recentInc = state.incomes.slice(-6).map((i) => `${i.date.slice(0, 10)} ${m(i.amount)}${i.source ? ' from ' + i.source : ''}`);
    if (recentInc.length) out.push('Recent incomes: ' + recentInc.join('; '));
    const recentTx = state.transactions.slice(-15).map((t) => {
      const { section, category } = findCategory(state, t.sectionId, t.categoryId);
      return `${t.date.slice(0, 10)} ${m(t.amount)} ${section ? section.name : '?'}→${category ? category.name : '?'}${t.note ? ' (' + t.note + ')' : ''}`;
    });
    if (recentTx.length) out.push('Recent spending/payments: ' + recentTx.join('; '));
    if (focusIncome) {
      out.push(`NEW INCOME JUST LOGGED: ${m(focusIncome.amount)}${focusIncome.source ? ' from ' + focusIncome.source : ''}. It was split as:`);
      focusIncome.allocations.forEach((a) => {
        const { section, category } = findCategory(state, a.sectionId, a.categoryId);
        if (a.amount) out.push(`   • ${section ? section.name : '?'} → ${category ? category.name : '?'}: ${m(a.amount)}`);
      });
    }
    return out.join('\n');
  }

  /** Offline advice used when no API key is set or the AI call fails. */
  function fallbackAdvice(state, income) {
    const bal = balances(state);
    const tips = [];
    const m = (n) => money(n, state);
    const byType = (t) => bal.sections.filter((s) => s.type === t);
    const pctOf = (t) => sum(byType(t), (s) => s.percent);
    if (income) tips.push(`You logged ${m(income.amount)}. It has been split across ${state.sections.length} sections according to your plan.`);
    const debts = byType('debt').flatMap((s) => s.categories.filter((c) => c.progress && c.progress.remaining > 0));
    if (debts.length) {
      const owed = sum(debts, (c) => c.progress.remaining);
      tips.push(`You still owe ${m(owed)} in total. Paying the debt with the highest interest first (or the smallest balance first, for motivation) usually works best.`);
    }
    const emergency = state.sections.filter((s) => /emergenc|buffer/i.test(s.name) || s.categories.some((c) => /emergenc|buffer/i.test(c.name)));
    if (!emergency.length) tips.push('There is no emergency fund section. Most planners suggest building 3–6 months of living costs before investing heavily.');
    if (pctOf('save') + pctOf('invest') < 20) tips.push(`Only ${pctOf('save') + pctOf('invest')}% of income goes to savings and investments. A common rule of thumb is at least 20%.`);
    if (pctOf('spend') > 50) tips.push(`Spending takes ${pctOf('spend')}% of your income — above the 50% often recommended for needs and wants combined.`);
    const over = bal.sections.flatMap((s) => s.categories.filter((c) => c.available < 0).map((c) => `${s.name} → ${c.name}`));
    if (over.length) tips.push(`Over budget in: ${over.join(', ')}. Consider moving money into these, or spending less there next period.`);
    const goals = bal.sections.flatMap((s) => s.categories.filter((c) => c.progress && c.progress.kind === 'goal'));
    goals.forEach((g) => { if (g.progress.pct < 100) tips.push(`${g.name}: ${Math.round(g.progress.pct)}% of the ${m(g.target)} goal reached.`); });
    if (tips.length <= 1) tips.push('Your plan looks balanced. Keep logging every payment so the numbers stay accurate.');
    return tips.join('\n\n') + '\n\n(Offline tips — add an Anthropic API key in Settings for personalised AI advice.)';
  }


  // ---------- Dates ----------
  const monthKey = (d) => String(d).slice(0, 7);
  function localToday() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function addMonths(ym, n) { const [y, mo] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); }
  function monthLabel(ym) { const [y, mo] = ym.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }

  // ---------- Currency ----------
  function toUSD(amount, currency, rate) { return currency === 'LBP' ? round2(Number(amount) / (Number(rate) || 89500)) : round2(amount); }

  // ---------- Wallets ----------
  function walletBalances(state) {
    const w = {}; state.settings.wallets.forEach((x) => { w[x.id] = { id: x.id, name: x.name, balance: Number(x.opening) || 0, in: 0, out: 0 }; });
    state.incomes.forEach((i) => { const x = w[i.walletId]; if (x) { x.balance += i.amount; x.in += i.amount; } });
    state.transactions.forEach((t) => { const x = w[t.walletId]; if (x) { x.balance -= t.amount; x.out += t.amount; } });
    state.walletTransfers.forEach((t) => { if (w[t.fromWalletId]) w[t.fromWalletId].balance -= t.amount; if (w[t.toWalletId]) w[t.toWalletId].balance += t.amount; });
    return Object.values(w).map((x) => Object.assign(x, { balance: round2(x.balance), in: round2(x.in), out: round2(x.out) }));
  }

  // ---------- Reports ----------
  /** Month-by-month totals. Returns [{month, income, out, byType:{spend,save,...}, net, cumulative}] */
  function monthlySeries(state, months) {
    const secType = {}; state.sections.forEach((s) => { secType[s.id] = s.type; });
    const keys = new Set();
    state.incomes.forEach((i) => keys.add(monthKey(i.date)));
    state.transactions.forEach((t) => keys.add(monthKey(t.date)));
    const now = monthKey(localToday());
    keys.add(now);
    let first = [...keys].sort()[0];
    if (months) first = addMonths(now, -(months - 1));
    const list = []; for (let m = first; m <= now; m = addMonths(m, 1)) list.push(m);
    const map = {}; list.forEach((m) => { map[m] = { month: m, income: 0, out: 0, byType: {} }; });
    let carry = 0;
    // carry-in before first month
    state.incomes.forEach((i) => { if (monthKey(i.date) < first) carry += i.amount; });
    state.transactions.forEach((t) => { if (monthKey(t.date) < first) carry -= t.amount; });
    state.incomes.forEach((i) => { const r = map[monthKey(i.date)]; if (r) r.income += i.amount; });
    state.transactions.forEach((t) => {
      const r = map[monthKey(t.date)]; if (!r) return;
      r.out += t.amount; const ty = secType[t.sectionId] || 'other'; r.byType[ty] = (r.byType[ty] || 0) + t.amount;
    });
    return list.map((m) => { const r = map[m]; r.income = round2(r.income); r.out = round2(r.out); r.net = round2(r.income - r.out); carry += r.net; r.cumulative = round2(carry); return r; });
  }

  /** Spending per category in a date range [from, to] (inclusive YYYY-MM-DD). */
  function spendingByCategory(state, from, to) {
    const rows = {};
    state.transactions.forEach((t) => {
      if ((from && t.date < from) || (to && t.date > to)) return;
      const { section, category } = findCategory(state, t.sectionId, t.categoryId);
      const k = t.sectionId + '|' + t.categoryId;
      if (!rows[k]) rows[k] = { name: category ? category.name : '(deleted)', section: section ? section.name : '?', color: section ? section.color : '#888', type: section ? section.type : 'other', amount: 0, count: 0 };
      rows[k].amount += t.amount; rows[k].count++;
    });
    return Object.values(rows).map((r) => Object.assign(r, { amount: round2(r.amount) })).sort((a, b) => b.amount - a.amount);
  }

  /** Average monthly income over the last `n` months that had income (fallback: all). */
  function avgMonthlyIncome(state, n) {
    const by = {}; state.incomes.forEach((i) => { const k = monthKey(i.date); by[k] = (by[k] || 0) + i.amount; });
    const keys = Object.keys(by).sort().slice(-(n || 3));
    if (!keys.length) return 0;
    return round2(sum(keys.map((k) => by[k])) / keys.length);
  }

  // ---------- Goals ----------
  /** For each goal (non-debt category with a target): saved, monthly rate from the plan, months left, ETA. */
  function goalTimelines(state, extras) {
    const bal = balances(state);
    const inc = avgMonthlyIncome(state, 3);
    const out = [];
    bal.sections.forEach((s) => {
      if (s.type === 'debt') return;
      s.categories.forEach((c) => {
        if (!(c.target > 0)) return;
        const planRate = round2(inc * (s.percent / 100) * (c.percent / 100));
        const extra = Number(extras && extras[c.categoryId]) || 0;
        const rate = planRate + extra;
        const saved = Math.max(0, c.available);
        const left = round2(Math.max(0, c.target - saved));
        const months = left <= 0 ? 0 : rate > 0 ? Math.ceil(left / rate) : null;
        const eta = months == null ? null : addMonths(monthKey(localToday()), months);
        out.push({ sectionId: s.id, categoryId: c.categoryId, section: s.name, name: c.name, color: s.color, target: c.target, saved: round2(saved), left, planRate, extra, rate: round2(rate), months, eta, pct: Math.min(100, (saved / c.target) * 100) });
      });
    });
    return out;
  }

  // ---------- Debt planner ----------
  /** Simulate paying debts with `budget` per month. strategy: 'avalanche' (highest APR first) | 'snowball' (smallest balance first). */
  function debtPlan(debts, budget, strategy) {
    let list = debts.filter((d) => d.balance > 0).map((d) => ({ name: d.name, balance: Number(d.balance), apr: Number(d.apr) || 0, min: Number(d.minPayment) || 0, interest: 0, paidOffMonth: null }));
    const minTotal = sum(list, (d) => Math.min(d.min, d.balance));
    if (!list.length) return { ok: true, months: 0, totalInterest: 0, debts: [], minTotal: 0 };
    if (budget <= 0) return { ok: false, reason: 'no-budget', minTotal, debts: list };
    let month = 0, totalInterest = 0;
    while (list.some((d) => d.balance > 0.005) && month < 600) {
      month++;
      list.forEach((d) => { if (d.balance > 0) { const i = d.balance * d.apr / 1200; d.balance += i; d.interest += i; totalInterest += i; } });
      let money = budget;
      list.forEach((d) => { if (d.balance > 0) { const p = Math.min(d.min, d.balance, money); d.balance -= p; money -= p; } });
      const order = list.filter((d) => d.balance > 0.005).sort((a, b) => strategy === 'snowball' ? a.balance - b.balance : b.apr - a.apr || a.balance - b.balance);
      for (const d of order) { if (money <= 0) break; const p = Math.min(d.balance, money); d.balance -= p; money -= p; }
      list.forEach((d) => { if (d.balance <= 0.005 && d.paidOffMonth == null) { d.balance = 0; d.paidOffMonth = month; } });
      if (month === 1 && budget < minTotal) { /* still simulate, but flag */ }
    }
    const ok = month < 600;
    return { ok, reason: ok ? '' : 'never', months: month, totalInterest: round2(totalInterest), minTotal: round2(minTotal), underMin: budget < minTotal,
      debts: list.map((d) => ({ name: d.name, apr: d.apr, interest: round2(d.interest), paidOffMonth: d.paidOffMonth })) };
  }

  /** Current debts from the plan (debt-type categories with a total). */
  function currentDebts(state) {
    const bal = balances(state);
    const out = [];
    bal.sections.forEach((s) => { if (s.type !== 'debt') return; s.categories.forEach((c) => {
      const cat = s.categories && state.sections.find((x) => x.id === s.id).categories.find((x) => x.id === c.categoryId);
      if (c.target > 0) out.push({ sectionId: s.id, categoryId: c.categoryId, name: c.name, balance: round2(Math.max(0, c.target - c.spent)), apr: cat.apr || 0, minPayment: cat.minPayment || 0 });
    }); });
    return out;
  }

  // ---------- Recurring ----------
  /** Recurring items that are due this month and not yet logged. */
  function dueRecurring(state, today) {
    today = today || localToday();
    const ym = monthKey(today), day = Number(today.slice(8, 10));
    return state.recurring.filter((r) => r.lastLogged !== ym && day >= Math.min(Number(r.day) || 1, 28));
  }
  function upcomingRecurring(state, today, withinDays) {
    today = today || localToday();
    const ym = monthKey(today), day = Number(today.slice(8, 10));
    return state.recurring.filter((r) => r.lastLogged !== ym && (Number(r.day) || 1) > day && (Number(r.day) || 1) - day <= (withinDays || 3));
  }
  function recurringTx(r, today) {
    const ym = monthKey(today || localToday());
    const dd = String(Math.min(Number(r.day) || 1, 28)).padStart(2, '0');
    return { id: 'rctx_' + r.id + '_' + ym, createdAt: Date.now(), date: `${ym}-${dd}`, sectionId: r.sectionId, categoryId: r.categoryId, amount: round2(r.amount), walletId: r.walletId, method: '', note: r.name + ' (recurring)', recurringId: r.id };
  }

  // ---------- Export ----------
  function toCSV(state) {
    const q = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const wName = {}; state.settings.wallets.forEach((w) => { wName[w.id] = w.name; });
    const rows = [['Date', 'Type', 'Section', 'Category', 'Wallet', 'Amount (' + state.settings.currency + ')', 'Original amount', 'Note']];
    state.incomes.forEach((i) => rows.push([i.date, 'Income', '', i.source || '', wName[i.walletId] || '', i.amount, i.original ? i.original.amount + ' ' + i.original.currency : '', i.note || '']));
    state.transactions.forEach((t) => { const { section, category } = findCategory(state, t.sectionId, t.categoryId);
      rows.push([t.date, 'Payment', section ? section.name : '', category ? category.name : '', wName[t.walletId] || '', -t.amount, t.original ? t.original.amount + ' ' + t.original.currency : '', t.note || '']); });
    state.transfers.forEach((t) => { const a = findCategory(state, t.from.sectionId, t.from.categoryId), b = findCategory(state, t.to.sectionId, t.to.categoryId);
      rows.push([t.date, 'Bucket transfer', (a.section ? a.section.name : '') + ' → ' + (b.section ? b.section.name : ''), (a.category ? a.category.name : '') + ' → ' + (b.category ? b.category.name : ''), '', t.amount, '', t.note || '']); });
    rows.splice(1, rows.length, ...rows.slice(1).sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n');
  }


  // ---------- Sync helpers ----------
  const DEVICE_KEYS = ['apiKey', 'pinHash', 'theme'];
  const LIST_KEYS = ['incomes', 'transactions', 'transfers', 'walletTransfers', 'recurring'];
  const stamp = (x) => x.updatedAt || x.createdAt || 0;

  /** Merge two copies of the same budget (e.g. this device and the server). Entries are combined by id,
      deletions are kept as tombstones, the plan/settings come from whichever copy changed them last. */
  function mergeStates(local, remote, opts) {
    if (!remote || !remote.settings) return local;
    if (!local || !local.settings) return migrate(remote);
    const preferRemote = opts && opts.preferRemote;
    const a = local, b = migrate(JSON.parse(JSON.stringify(remote)));
    const out = Object.assign({}, a);
    const deleted = Object.assign({}, b.deleted || {}, a.deleted || {});
    out.deleted = deleted;
    LIST_KEYS.forEach((k) => {
      const map = new Map();
      (b[k] || []).forEach((x) => map.set(x.id, x));
      (a[k] || []).forEach((x) => {
        const y = map.get(x.id);
        if (!y) { map.set(x.id, x); return; }
        let pick = stamp(x) > stamp(y) || (stamp(x) === stamp(y) && !preferRemote) ? x : y;
        if (k === 'recurring') pick = Object.assign({}, pick, { lastLogged: [x.lastLogged || '', y.lastLogged || ''].sort().pop() });
        map.set(x.id, pick);
      });
      out[k] = [...map.values()].filter((x) => !deleted[x.id]).sort((p, q) => String(p.date || '').localeCompare(String(q.date || '')) || (p.createdAt || 0) - (q.createdAt || 0) || String(p.id).localeCompare(String(q.id)));
    });
    const reps = new Map();
    [...(b.monthlyReports || []), ...(a.monthlyReports || [])].forEach((r) => { const o = reps.get(r.month); if (!o || String(r.date) >= String(o.date)) reps.set(r.month, r); });
    out.monthlyReports = [...reps.values()].sort((p, q) => p.month.localeCompare(q.month));
    const pa = a.planUpdatedAt || 0, pb = b.planUpdatedAt || 0;
    out.sections = pb > pa || (pb === pa && preferRemote) ? b.sections : a.sections;
    out.planUpdatedAt = Math.max(pa, pb);
    const sa = a.settingsUpdatedAt || 0, sb = b.settingsUpdatedAt || 0;
    const baseSettings = sb > sa || (sb === sa && preferRemote) ? b.settings : a.settings;
    out.settings = Object.assign({}, baseSettings);
    DEVICE_KEYS.forEach((k) => { out.settings[k] = a.settings[k]; });
    out.settingsUpdatedAt = Math.max(sa, sb);
    out.chat = a.chat || [];
    return out;
  }

  /** The copy of a budget that is uploaded: no device secrets, no private AI chat. */
  function forUpload(state) {
    const c = JSON.parse(JSON.stringify(state));
    DEVICE_KEYS.forEach((k) => { delete c.settings[k]; });
    c.chat = [];
    return c;
  }
  const sameBudget = (x, y) => JSON.stringify(forUpload(x)) === JSON.stringify(forUpload(y));
  const isEmptyBudget = (st) => !st || (!(st.incomes || []).length && !(st.transactions || []).length);


  // ---------- Safe mini-markdown for AI text (bold, italics, lists, headings, code) ----------
  function mdToHtml(text) {
    const e = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const inline = (t) => e(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let html = '', list = null, para = [];
    const flushPara = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    lines.forEach((ln) => {
      const t = ln.trim();
      let mm;
      if (!t) { flushPara(); closeList(); return; }
      if ((mm = t.match(/^#{1,4}\s+(.*)$/))) { flushPara(); closeList(); html += `<h4>${inline(mm[1])}</h4>`; return; }
      if ((mm = t.match(/^[-*•]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(mm[1])}</li>`; return; }
      if ((mm = t.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(mm[1])}</li>`; return; }
      closeList(); para.push(t);
    });
    flushPara(); closeList();
    return html;
  }

  return {
    TEMPLATES, templateSections,
    mdToHtml,
    mergeStates, forUpload, sameBudget, isEmptyBudget, DEVICE_KEYS,
    monthKey, localToday, addMonths, monthLabel, toUSD, walletBalances, monthlySeries, spendingByCategory, avgMonthlyIncome,
    goalTimelines, debtPlan, currentDebts, dueRecurring, upcomingRecurring, recurringTx, toCSV,
    SCHEMA_VERSION, SECTION_TYPES, PALETTE,
    uid, round2, sum, defaultState, migrate, validatePlan, distribute, splitIncome,
    findCategory, balances, money, paymentMessage, summaryForAI, fallbackAdvice
  };
});
