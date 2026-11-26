const assert = require('assert');
const L = require('../src/logic.js');
// The tests use the original five-section plan so their expected numbers stay fixed.
function legacyState() {
  const st = L.defaultState();
  const c = (name, percent, target) => ({ id: L.uid('cat'), name, percent, target: target || 0, note: '', apr: 0, minPayment: 0 });
  st.sections = [
    { id: L.uid('sec'), name: 'Allowance', type: 'spend', percent: 35, color: '#7c9cff', categories: [c('Food & daily', 50), c('Transport', 20), c('Personal', 30)] },
    { id: L.uid('sec'), name: 'Savings', type: 'save', percent: 20, color: '#5fd3a7', categories: [c('Wedding', 50), c('Car', 30), c('House & furniture', 20)] },
    { id: L.uid('sec'), name: 'Emergency', type: 'save', percent: 10, color: '#f2b45b', categories: [c('6-month buffer', 100, 4500)] },
    { id: L.uid('sec'), name: 'Debts', type: 'debt', percent: 15, color: '#f07a8a', categories: [c('Example debt (rename me)', 100, 1000)] },
    { id: L.uid('sec'), name: 'Investments', type: 'invest', percent: 15, color: '#b48cf2', categories: [c('Long-term', 70), c('Short-term', 30)] },
    { id: L.uid('sec'), name: 'Business', type: 'business', percent: 5, color: '#5cc6e8', categories: [c('Capital', 100)] }];
  st.settings.wallets = [{ id: 'w_cash', name: 'Cash', opening: 0 }, { id: 'w_wish', name: 'Wish Money card', opening: 0 }];
  return st;
}

let s = legacyState();
assert.ok(L.validatePlan(s.sections).ok, 'default plan valid');

// Split $1,700 and check it adds up to the cent
const split = L.splitIncome(1700, s.sections);
assert.strictEqual(L.round2(L.sum(split.allocations, (a) => a.amount)), 1700);
assert.strictEqual(split.sectionAmounts[0].amount, 595); // Allowance 35%

// Awkward amount still adds up exactly
const odd = L.splitIncome(1234.57, s.sections);
assert.strictEqual(L.round2(L.sum(odd.allocations, (a) => a.amount)), 1234.57);

// One-off override
const ov = {}; s.sections.forEach((x) => (ov[x.id] = 0)); ov[s.sections[0].id] = 100;
const o = L.splitIncome(500, s.sections, ov);
assert.strictEqual(o.sectionAmounts[0].amount, 500);

// Log income, pay a debt
s.incomes.push({ id: 'i1', date: '2026-11-26', amount: 1700, allocations: split.allocations });
const debtSec = s.sections.find((x) => x.type === 'debt');
const debtCat = debtSec.categories[0];
const tx = { id: 't1', date: '2026-11-26', sectionId: debtSec.id, categoryId: debtCat.id, amount: 200, method: 'Cash' };
s.transactions.push(tx);
const b = L.balances(s).get(debtSec.id, debtCat.id);
assert.strictEqual(b.allocated, 255);
assert.strictEqual(b.available, 55);
const msg = L.paymentMessage(s, tx);
console.log('Payment message:', msg);
assert.ok(msg.includes('$200.00 was paid for'));
assert.ok(msg.includes('$55.00 remaining'));
assert.ok(msg.includes('$800.00 still owed of $1,000.00'));

// Transfer
const allow = s.sections[0];
s.transfers.push({ id: 'tr1', date: '2026-11-26', from: { sectionId: allow.id, categoryId: allow.categories[0].id }, to: { sectionId: debtSec.id, categoryId: debtCat.id }, amount: 45 });
assert.strictEqual(L.balances(s).get(debtSec.id, debtCat.id).available, 100);
assert.strictEqual(L.round2(L.balances(s).totalAvailable), 1500);

// Validation catches bad totals
const bad = JSON.parse(JSON.stringify(s.sections)); bad[0].percent = 50;
assert.ok(!L.validatePlan(bad).ok);

// Migration keeps data and fills gaps
const mig = L.migrate({ incomes: s.incomes, sections: s.sections });
assert.strictEqual(mig.incomes.length, 1);
assert.ok(Array.isArray(mig.transfers) && mig.settings.currency === 'USD');

assert.ok(L.summaryForAI(s, s.incomes[0]).includes('NEW INCOME JUST LOGGED'));
assert.ok(L.fallbackAdvice(s, s.incomes[0]).length > 50);
console.log('All logic tests passed.');

// ---------- v1.1 features ----------
{
  const t = L.migrate({ settings: { paymentMethods: ['Cash', 'Card'] }, transactions: [{ id: 'x', date: '2026-01-01', sectionId: 'a', categoryId: 'b', amount: 5, method: 'Card' }] });
  assert.strictEqual(t.settings.wallets.length, 2);
  assert.strictEqual(t.transactions[0].walletId, t.settings.wallets[1].id, 'old method maps to wallet');
  assert.strictEqual(t.settings.model, 'claude-haiku-5-5');

  assert.strictEqual(L.toUSD(895000, 'LBP', 89500), 10);
  assert.strictEqual(L.toUSD(12.345, 'USD'), 12.35);

  const st = legacyState();
  const w = st.settings.wallets;
  const sp = L.splitIncome(1000, st.sections);
  st.incomes.push({ id: 'i', date: L.localToday(), amount: 1000, walletId: w[0].id, allocations: sp.allocations });
  const allow = st.sections[0];
  st.transactions.push({ id: 't', date: L.localToday(), sectionId: allow.id, categoryId: allow.categories[0].id, amount: 100, walletId: w[1].id });
  st.walletTransfers.push({ id: 'wt', date: L.localToday(), fromWalletId: w[0].id, toWalletId: w[1].id, amount: 300 });
  const wb = L.walletBalances(st);
  assert.strictEqual(wb[0].balance, 700); assert.strictEqual(wb[1].balance, 200);

  const ms = L.monthlySeries(st, 6);
  assert.strictEqual(ms.length, 6);
  assert.strictEqual(ms[5].income, 1000); assert.strictEqual(ms[5].out, 100); assert.strictEqual(ms[5].cumulative, 900);
  assert.strictEqual(L.spendingByCategory(st)[0].amount, 100);

  // goal: emergency 6-month buffer target 4500, plan rate = 1000*10%*100% = 100/mo, saved 100 → 44 months
  const g = L.goalTimelines(st).find((x) => x.name === '6-month buffer');
  assert.strictEqual(g.planRate, 100); assert.strictEqual(g.saved, 100); assert.strictEqual(g.months, 44);
  const g2 = L.goalTimelines(st, { [g.categoryId]: 100 }).find((x) => x.name === '6-month buffer');
  assert.strictEqual(g2.months, 22);

  // debt planner: two debts, avalanche pays less interest than snowball
  const debts = [{ name: 'Card', balance: 2000, apr: 24, minPayment: 50 }, { name: 'Loan', balance: 500, apr: 5, minPayment: 25 }];
  const av = L.debtPlan(debts, 300, 'avalanche'), sb = L.debtPlan(debts, 300, 'snowball');
  assert.ok(av.ok && sb.ok); assert.ok(av.totalInterest < sb.totalInterest, 'avalanche cheaper');
  assert.strictEqual(sb.debts.find((d) => d.name === 'Loan').paidOffMonth < av.debts.find((d) => d.name === 'Loan').paidOffMonth, true);
  assert.strictEqual(L.debtPlan([{ name: 'x', balance: 1200, apr: 0, minPayment: 0 }], 100).months, 12);
  assert.ok(!L.debtPlan([{ name: 'x', balance: 100000, apr: 30, minPayment: 0 }], 100).ok, 'never paid off');

  // recurring
  st.recurring.push({ id: 'r1', name: 'Rent', amount: 400, sectionId: allow.id, categoryId: allow.categories[0].id, walletId: w[0].id, day: 1, auto: true, lastLogged: '' });
  assert.strictEqual(L.dueRecurring(st, '2026-12-05').length, 1);
  st.recurring[0].lastLogged = '2026-12';
  assert.strictEqual(L.dueRecurring(st, '2026-12-20').length, 0);
  assert.strictEqual(L.dueRecurring(st, '2027-01-01').length, 1);
  assert.strictEqual(L.recurringTx(st.recurring[0], '2027-01-03').date, '2027-01-01');

  const csv = L.toCSV(st);
  assert.ok(csv.includes('Payment') && csv.includes('Income') && csv.split('\r\n').length === 3);
  console.log('v1.1 feature tests passed.');
}

// ---------- sync merge ----------
{
  const base = legacyState(); base.settings.apiKey = 'local-key';
  const A = JSON.parse(JSON.stringify(base)), B = L.forUpload(JSON.parse(JSON.stringify(base)));
  A.transactions.push({ id: 'a1', createdAt: 1, date: '2026-11-01', amount: 5 });
  B.transactions.push({ id: 'b1', createdAt: 2, date: '2026-11-02', amount: 7 });
  A.transactions.push({ id: 'x', createdAt: 1, date: '2026-11-03', amount: 1 });
  B.transactions.push({ id: 'x', createdAt: 1, updatedAt: 9, date: '2026-11-03', amount: 2 }); // edited remotely
  B.incomes.push({ id: 'gone', createdAt: 1, date: '2026-11-01', amount: 100, allocations: [] }); A.deleted = { gone: 5 }; // deleted locally
  B.sections[0].name = 'Fun money'; B.planUpdatedAt = 50;
  const M = L.mergeStates(A, B);
  assert.deepStrictEqual(M.transactions.map((t) => t.id), ['a1', 'b1', 'x']);
  assert.strictEqual(M.transactions[2].amount, 2, 'newer edit wins');
  assert.strictEqual(M.incomes.length, 0, 'tombstone removes');
  assert.strictEqual(M.sections[0].name, 'Fun money', 'newer plan wins');
  assert.strictEqual(M.settings.apiKey, 'local-key', 'device key kept');
  assert.ok(!('apiKey' in L.forUpload(M).settings), 'key never uploaded');
  assert.ok(L.sameBudget(L.mergeStates(M, L.forUpload(M)), M));
  // recurring: same bill logged on two devices -> one transaction
  const r = { id: 'r9', name: 'Rent', amount: 10, day: 1 };
  const t1 = L.recurringTx(r, '2026-12-03'), t2 = L.recurringTx(r, '2026-12-05');
  assert.strictEqual(t1.id, t2.id);
  console.log('sync merge tests passed.');
}
