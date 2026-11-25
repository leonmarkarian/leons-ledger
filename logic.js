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

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        currency: 'USD',
        currencySymbol: '$',
        apiKey: '',
        model: 'claude-sonnet-5-5',
        aiEnabled: true,
        autoAdviceOnIncome: true,
        paymentMethods: ['Cash', 'Wish Money card'],
        aboutMe:
          'Goals: financial independence; wedding planned for mid-summer 2027; a car (a need, not optional); ' +
          'a house (prefer to buy, else rent) and furniture; a 6-month emergency buffer. ' +
          'Monthly living costs roughly $500–1,000. Planning to start a business and keep its money separate.'
      },
      sections: [
        { id: uid('sec'), name: 'Allowance', type: 'spend', percent: 35, color: PALETTE[0], categories: [
          cat('Food & daily', 50), cat('Transport', 20), cat('Personal', 30)] },
        { id: uid('sec'), name: 'Savings', type: 'save', percent: 20, color: PALETTE[1], categories: [
          cat('Wedding', 50, { target: 0 }), cat('Car', 30, { target: 0 }), cat('House & furniture', 20, { target: 0 })] },
        { id: uid('sec'), name: 'Emergency', type: 'save', percent: 10, color: PALETTE[2], categories: [
          cat('6-month buffer', 100, { target: 4500 })] },
        { id: uid('sec'), name: 'Debts', type: 'debt', percent: 15, color: PALETTE[3], categories: [
          cat('Example debt (rename me)', 100, { target: 1000 })] },
        { id: uid('sec'), name: 'Investments', type: 'invest', percent: 15, color: PALETTE[4], categories: [
          cat('Long-term', 70), cat('Short-term', 30)] },
        { id: uid('sec'), name: 'Business', type: 'other', percent: 5, color: PALETTE[5], categories: [
          cat('Capital', 100)] }
      ],
      incomes: [],       // {id,date,amount,source,note,allocations:[{sectionId,categoryId,amount}],advice}
      transactions: [],  // {id,date,sectionId,categoryId,amount,method,note}
      transfers: [],     // {id,date,from:{sectionId,categoryId},to:{...},amount,note}
      chat: []           // {role:'user'|'assistant', content, date}
    };
  }

  /** Bring an older / partial state up to the current shape without losing data. */
  function migrate(state) {
    const base = defaultState();
    if (!state || typeof state !== 'object') return base;
    const s = Object.assign({}, base, state);
    s.settings = Object.assign({}, base.settings, state.settings || {});
    ['incomes', 'transactions', 'transfers', 'chat'].forEach((k) => { if (!Array.isArray(s[k])) s[k] = []; });
    if (!Array.isArray(s.sections) || !s.sections.length) s.sections = base.sections;
    s.sections.forEach((sec, i) => {
      sec.id = sec.id || uid('sec');
      sec.type = SECTION_TYPES[sec.type] ? sec.type : 'other';
      sec.color = sec.color || PALETTE[i % PALETTE.length];
      sec.percent = Number(sec.percent) || 0;
      sec.categories = Array.isArray(sec.categories) && sec.categories.length ? sec.categories : [cat('General', 100)];
      sec.categories.forEach((c) => {
        c.id = c.id || uid('cat');
        c.percent = Number(c.percent) || 0;
        c.target = Number(c.target) || 0;
        c.note = c.note || '';
      });
    });
    s.schemaVersion = SCHEMA_VERSION;
    return s;
  }

  /** Check that section %s total 100 and each section's category %s total 100. */
  function validatePlan(sections) {
    const errors = [];
    const total = round2(sum(sections, (s) => Number(s.percent) || 0));
    if (Math.abs(total - 100) > 0.001) errors.push(`Sections add up to ${total}% — they need to total 100%.`);
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

  return {
    SCHEMA_VERSION, SECTION_TYPES, PALETTE,
    uid, round2, sum, defaultState, migrate, validatePlan, distribute, splitIncome,
    findCategory, balances, money, paymentMessage, summaryForAI, fallbackAdvice
  };
});
