const assert = require('assert');
const L = require('../src/logic.js');

let s = L.defaultState();
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
