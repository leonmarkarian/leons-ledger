/* Leon's Ledger — designed PDF report (A4). Builds a standalone HTML document. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const INK = '#111114', MUTED = '#6b6b76', LINE = '#ececf0', ACCENT = '#ff2e7a', GOOD = '#12a06b', SOFT = '#f6f6f8';

  function build(state, L, opts) {
    opts = opts || {};
    const m = (n) => L.money(n, state);
    const short = (v) => { const a = Math.abs(v), sg = v < 0 ? '-' : '', sy = state.settings.currencySymbol || '$';
      return a >= 1e6 ? `${sg}${sy}${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${sg}${sy}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `${sg}${sy}${Math.round(a)}`; };
    const months = opts.months || 6;
    const series = L.monthlySeries(state, months || null);
    const from = series[0].month, to = series[series.length - 1].month;
    const totIn = L.round2(L.sum(series, (r) => r.income)), totOut = L.round2(L.sum(series, (r) => r.out));
    const kept = totIn ? Math.round((totIn - totOut) / totIn * 100) : 0;
    const bal = L.balances(state);
    const cats = L.spendingByCategory(state, from + '-01');
    const catMax = Math.max(1, ...cats.map((c) => c.amount));
    const goals = L.goalTimelines(state);
    const debts = L.currentDebts(state);
    const inc = L.avgMonthlyIncome(state, 3);
    const debtBudget = L.round2(inc * L.sum(state.sections.filter((x) => x.type === 'debt'), (x) => x.percent) / 100);
    const plan = debts.length ? L.debtPlan(debts, debtBudget, 'avalanche') : null;
    const wallets = L.walletBalances(state);
    const thisMonth = L.monthKey(L.localToday());
    const report = state.monthlyReports.slice().sort((a, b) => b.month.localeCompare(a.month))[0];
    const name = state.settings.userName;
    const period = from === to ? L.monthLabel(from) : `${L.monthLabel(from)} – ${L.monthLabel(to)}`;
    const generated = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // ---- charts with fixed colours
    const bars = (() => {
      const W = 520, H = 190, pl = 46, pr = 6, pt = 10, pb = 24;
      const max = Math.max(1, ...series.map((r) => Math.max(r.income, r.out)));
      const n = series.length, gw = (W - pl - pr) / n, bw = Math.min(18, gw * 0.32);
      const y = (v) => pt + (H - pt - pb) * (1 - v / max);
      return `<svg viewBox="0 0 ${W} ${H}" width="100%">${[0, .5, 1].map((k) => `<line x1="${pl}" x2="${W - pr}" y1="${y(max * k)}" y2="${y(max * k)}" stroke="${LINE}"/><text x="${pl - 6}" y="${y(max * k) + 3.5}" font-size="9" fill="${MUTED}" text-anchor="end">${short(max * k)}</text>`).join('')}
        ${series.map((r, i) => { const x = pl + gw * i + gw / 2; return `
          <rect x="${x - bw - 1.5}" y="${y(r.income)}" width="${bw}" height="${H - pb - y(r.income)}" rx="3" fill="${GOOD}"/>
          <rect x="${x + 1.5}" y="${y(r.out)}" width="${bw}" height="${H - pb - y(r.out)}" rx="3" fill="${ACCENT}"/>
          <text x="${x}" y="${H - 8}" font-size="9" fill="${MUTED}" text-anchor="middle">${L.monthLabel(r.month).split(' ')[0]}</text>`; }).join('')}</svg>`;
    })();
    const line = (() => {
      const W = 520, H = 150, pl = 46, pr = 10, pt = 10, pb = 22;
      const vals = series.map((r) => r.cumulative), max = Math.max(1, ...vals), min = Math.min(0, ...vals);
      const x = (i) => pl + (W - pl - pr) * (series.length === 1 ? 0.5 : i / (series.length - 1));
      const y = (v) => pt + (H - pt - pb) * (1 - (v - min) / (max - min || 1));
      const pts = series.map((r, i) => `${x(i)},${y(r.cumulative)}`).join(' ');
      return `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${ACCENT}" stop-opacity=".22"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>
        ${[min, (min + max) / 2, max].map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" stroke="${LINE}"/><text x="${pl - 6}" y="${y(t) + 3.5}" font-size="9" fill="${MUTED}" text-anchor="end">${short(t)}</text>`).join('')}
        <polygon points="${x(0)},${y(min)} ${pts} ${x(series.length - 1)},${y(min)}" fill="url(#g)"/>
        <polyline points="${pts}" fill="none" stroke="${ACCENT}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        ${series.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.cumulative)}" r="3" fill="#fff" stroke="${ACCENT}" stroke-width="1.8"/>`).join('')}
        ${series.map((r, i) => `<text x="${x(i)}" y="${H - 6}" font-size="9" fill="${MUTED}" text-anchor="middle">${L.monthLabel(r.month).split(' ')[0]}</text>`).join('')}</svg>`;
    })();
    const donut = (() => {
      const secs = bal.sections.filter((s) => s.percent > 0); let a0 = -Math.PI / 2; const R = 54, r = 34, cx = 64, cy = 64;
      const arcs = secs.map((s) => { const a1 = a0 + (s.percent / 100) * Math.PI * 2; const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (a, rad) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
        const d = `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`; a0 = a1;
        return `<path d="${d}" fill="${s.color}"/>`; }).join('');
      return `<svg viewBox="0 0 128 128" width="118" height="118">${arcs}<text x="64" y="61" text-anchor="middle" font-size="9" fill="${MUTED}">Split</text><text x="64" y="75" text-anchor="middle" font-size="13" font-weight="700" fill="${INK}">${secs.length}</text></svg>`;
    })();

    const css = `
      @page { size: A4; margin: 14mm 0 12mm; }
      @page :first { margin-top: 0; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: 'Segoe UI', 'Inter', -apple-system, system-ui, sans-serif; color: ${INK}; font-size: 10.5px; line-height: 1.45; background: #fff; }
      .page { padding: 0 34px 26px; }
      .hero { background: #000; color: #fff; padding: 30px 34px 26px; display: flex; align-items: center; gap: 18px; position: relative; overflow: hidden; }
      .hero::after { content: ''; position: absolute; right: -60px; top: -60px; width: 240px; height: 240px; border-radius: 50%; background: radial-gradient(circle, rgba(255,46,122,.55), rgba(255,46,122,0) 70%); }
      .hero .logo { width: 54px; height: 54px; border-radius: 14px; border: 1px solid #333; padding: 7px; flex: 0 0 auto; }
      .hero .logo svg { width: 100%; height: 100%; display: block; }
      .hero h1 { margin: 0; font-size: 22px; letter-spacing: -.2px; }
      .hero .meta { color: #b9b9c2; margin-top: 3px; font-size: 11px; }
      .hero .period { margin-left: auto; text-align: right; position: relative; z-index: 1; }
      .hero .period b { display: block; font-size: 14px; color: #fff; }
      .accent-bar { height: 4px; background: linear-gradient(90deg, ${ACCENT}, #ff8fb5); }
      h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .09em; color: ${INK}; margin: 22px 0 10px; display: flex; align-items: center; gap: 8px; }
      h2::before { content: ''; width: 4px; height: 14px; border-radius: 2px; background: ${ACCENT}; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 20px; }
      .kpi { background: ${SOFT}; border-radius: 12px; padding: 12px 14px; }
      .kpi .l { font-size: 8.5px; text-transform: uppercase; letter-spacing: .1em; color: ${MUTED}; }
      .kpi .v { font-size: 18px; font-weight: 700; margin-top: 4px; letter-spacing: -.3px; }
      .kpi .s { color: ${MUTED}; font-size: 9px; margin-top: 2px; }
      .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .box { border: 1px solid ${LINE}; border-radius: 12px; padding: 12px 14px; break-inside: avoid; }
      .box .t { font-weight: 700; font-size: 11px; margin-bottom: 4px; display: flex; justify-content: space-between; }
      .legend { display: flex; gap: 12px; font-weight: 400; color: ${MUTED}; font-size: 9px; }
      .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: -.5px; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em; color: ${MUTED}; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid ${LINE}; }
      td { padding: 7px 8px; border-bottom: 1px solid ${LINE}; vertical-align: middle; }
      tr { break-inside: avoid; }
      .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .bar { height: 6px; border-radius: 99px; background: #efeff3; overflow: hidden; min-width: 90px; }
      .bar i { display: block; height: 100%; border-radius: 99px; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
      .muted { color: ${MUTED}; } .good { color: ${GOOD}; } .bad { color: #d62f4b; }
      .plan { display: flex; gap: 18px; align-items: center; }
      .plan-list { flex: 1; }
      .plan-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed ${LINE}; }
      .ai { background: linear-gradient(180deg, #fff0f6, #fff); border: 1px solid #ffd0e2; border-radius: 12px; padding: 14px 16px; break-inside: avoid; }
      .ai p { margin: 0 0 8px; } .ai ul, .ai ol { margin: 0 0 8px; padding-left: 18px; } .ai h4 { margin: 8px 0 4px; }
      .wallets { display: grid; grid-template-columns: repeat(${Math.min(4, wallets.length)}, 1fr); gap: 10px; }
      .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid ${LINE}; color: ${MUTED}; font-size: 8.5px; display: flex; justify-content: space-between; }
      .section { break-inside: avoid; }
    `;

    const goalsHtml = goals.length ? `<table><thead><tr><th>Goal</th><th class="num">Saved</th><th class="num">Target</th><th style="width:28%">Progress</th><th class="num">Reached by</th></tr></thead><tbody>
      ${goals.map((g) => `<tr><td><span class="dot" style="background:${g.color}"></span><b>${esc(g.name)}</b> <span class="muted">${esc(g.section)}</span></td><td class="num">${m(g.saved)}</td><td class="num">${m(g.target)}</td>
        <td><div class="bar"><i style="width:${g.pct}%;background:${g.color}"></i></div><div class="muted" style="font-size:8.5px;margin-top:2px">${Math.round(g.pct)}%</div></td>
        <td class="num">${g.left <= 0 ? '<b class="good">Reached</b>' : g.eta ? `<b>${L.monthLabel(g.eta)}</b><div class="muted" style="font-size:8.5px">${g.months} months</div>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>` : '';

    const debtsHtml = debts.length ? `<table><thead><tr><th>Debt</th><th class="num">Interest</th><th class="num">Still owed</th><th class="num">Paid off (plan)</th></tr></thead><tbody>
      ${debts.map((d) => { const p = plan && plan.ok ? plan.debts.find((x) => x.name === d.name) : null;
        return `<tr><td><b>${esc(d.name)}</b></td><td class="num">${d.apr ? d.apr + '%/yr' : '<span class="muted">—</span>'}</td><td class="num">${m(d.balance)}</td><td class="num">${p ? L.monthLabel(L.addMonths(thisMonth, p.paidOffMonth)) : '<span class="muted">—</span>'}</td></tr>`; }).join('')}</tbody></table>
      ${plan && plan.ok ? `<p class="muted" style="margin:8px 2px 0">Paying ${m(debtBudget)} a month (highest interest first), you'll be debt-free by <b style="color:${INK}">${L.monthLabel(L.addMonths(thisMonth, plan.months))}</b> and pay about ${m(plan.totalInterest)} in interest.</p>` : ''}` : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Leon's Ledger report — ${esc(period)}</title><style>${css}</style></head><body>
      <div class="hero">
        <div class="logo">${opts.logoSvg || ''}</div>
        <div><h1>Financial report</h1><div class="meta">Leon's Ledger${name ? ' · ' + esc(name) : ''} · generated ${generated}</div></div>
        <div class="period"><span class="meta">Period</span><b>${esc(period)}</b></div>
      </div>
      <div class="accent-bar"></div>
      <div class="page">
        <div class="kpis">
          <div class="kpi"><div class="l">Income</div><div class="v good">${m(totIn)}</div><div class="s">${series.length} month${series.length === 1 ? '' : 's'}</div></div>
          <div class="kpi"><div class="l">Money out</div><div class="v">${m(totOut)}</div><div class="s">spent, paid & invested</div></div>
          <div class="kpi"><div class="l">Kept</div><div class="v ${kept < 0 ? 'bad' : ''}">${kept}%</div><div class="s">of income</div></div>
          <div class="kpi"><div class="l">Available now</div><div class="v">${m(bal.totalAvailable)}</div><div class="s">across all buckets</div></div>
        </div>

        <h2>Cash flow</h2>
        <div class="two">
          <div class="box"><div class="t">Income vs money out <span class="legend"><span><i style="background:${GOOD}"></i>Income</span><span><i style="background:${ACCENT}"></i>Out</span></span></div>${bars}</div>
          <div class="box"><div class="t">Balance over time</div>${line}</div>
        </div>

        <div class="section"><h2>Where the money went</h2>
        ${cats.length ? `<table><thead><tr><th>Category</th><th>Section</th><th style="width:34%"></th><th class="num">Amount</th><th class="num">Share</th></tr></thead><tbody>
          ${cats.slice(0, 12).map((c) => `<tr><td><span class="dot" style="background:${c.color}"></span><b>${esc(c.name)}</b></td><td class="muted">${esc(c.section)}</td><td><div class="bar"><i style="width:${c.amount / catMax * 100}%;background:${c.color}"></i></div></td><td class="num">${m(c.amount)}</td><td class="num muted">${totOut ? Math.round(c.amount / totOut * 100) : 0}%</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No spending logged in this period.</p>'}</div>

        <div class="section"><h2>Your split plan</h2>
        <div class="box plan">${donut}<div class="plan-list">${bal.sections.map((s) => `<div class="plan-row"><span><span class="dot" style="background:${s.color}"></span><b>${esc(s.name)}</b> <span class="muted">${s.percent}% of income</span></span><span>${m(s.available)} <span class="muted">available</span></span></div>`).join('')}</div></div></div>

        ${goalsHtml ? `<div class="section"><h2>Savings goals</h2>${goalsHtml}</div>` : ''}
        ${debtsHtml ? `<div class="section"><h2>Debts</h2>${debtsHtml}</div>` : ''}

        <div class="section"><h2>Wallets</h2>
        <div class="wallets">${wallets.map((w) => `<div class="kpi"><div class="l">${esc(w.name)}</div><div class="v ${w.balance < 0 ? 'bad' : ''}" style="font-size:15px">${m(w.balance)}</div></div>`).join('')}</div></div>

        ${report ? `<div class="section"><h2>AI review · ${L.monthLabel(report.month)}</h2><div class="ai">${L.mdToHtml(report.text)}</div></div>` : ''}

        <div class="foot"><span>Leon's Ledger · ${esc(state.settings.currency)} · figures from your own records</span><span>AI notes are general guidance, not licensed financial advice.</span></div>
      </div>
    </body></html>`;
  }

  root.LedgerReport = { build };
})(typeof self !== 'undefined' ? self : this);
