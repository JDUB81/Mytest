const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, as, post, addHome, addCustomer, openDeal } = require('./helpers');
const { dealTotals } = require('../src/deals');

let db;
let app;

beforeEach(() => {
  ({ db, app } = setup());
});

test('deal math: discount, add-ons, tax, trade-in, doc fee and payments', () => {
  const deal = { sale_price: 100000, discount: 5000, trade_allowance: 10000, trade_payoff: 4000, tax_rate: 5, doc_fee: 300 };
  const items = [
    { price: 6000, cost: 4000, taxable: 1 }, // setup
    { price: 1000, cost: null, taxable: 0 }, // permits
  ];
  const payments = [
    { kind: 'deposit', amount: 2500, voided_at: null },
    { kind: 'payment', amount: 1000, voided_at: '2026-01-01' }, // voided: ignored
    { kind: 'refund', amount: 500, voided_at: null },
  ];
  const home = { invoice_cost: 60000, freight_cost: 2000, other_cost: null };
  const t = dealTotals(deal, items, payments, home);
  assert.strictEqual(t.homeNet, 95000);
  assert.strictEqual(t.itemsTotal, 7000);
  assert.strictEqual(t.taxableBase, 91000); // 95000 + 6000 − 10000
  assert.strictEqual(t.tax, 4550);
  // 95000 + 7000 + 300 + 4550 − (10000 − 4000)
  assert.strictEqual(t.total, 100850);
  assert.strictEqual(t.paid, 2000);
  assert.strictEqual(t.deposits, 2500);
  assert.strictEqual(t.balance, 98850);
  // 95000 + 7000 + 300 − 62000 − 4000
  assert.strictEqual(t.grossProfit, 36300);
});

test('taxable base never goes negative with a big trade-in', () => {
  const t = dealTotals({ sale_price: 20000, discount: 0, trade_allowance: 30000, trade_payoff: 0, tax_rate: 6, doc_fee: 0 });
  assert.strictEqual(t.tax, 0);
  assert.strictEqual(t.total, -10000);
});

test('assigning a home opens a deal at list price with the default tax rate and doc fee', async () => {
  const boss = await as(app, 'boss');
  await post(boss, '/settings', { business_name: 'Premier Homes', default_tax_rate: '4.5', default_doc_fee: '250', commission_percent: '20' });
  const home = addHome(db, { price: 88000 });
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);
  assert.strictEqual(deal.sale_price, 88000);
  assert.strictEqual(deal.tax_rate, 4.5);
  assert.strictEqual(deal.doc_fee, 250);
  assert.strictEqual(deal.salesperson_id, 2); // customer has no salesperson, so the assigner
  assert.strictEqual(deal.created_by, 2);
});

test('sales can price a pending deal, add options and take a deposit, but never see dealer cost', async () => {
  const home = addHome(db, { price: 100000, invoice_cost: 71234 });
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);

  let res = await post(sam, `/deals/${deal.id}`, {
    sale_price: '98,500', discount: '1500', tax_rate: '5', doc_fee: '200', trade_allowance: '0', trade_payoff: '0',
    financing_type: 'chattel', lender: 'Triad Financial', salesperson_id: '2',
  });
  assert.strictEqual(res.status, 302);
  res = await post(sam, `/deals/${deal.id}/items`, { description: 'Delivery & setup', price: '4500', cost: '1', taxable: '1' });
  assert.strictEqual(res.status, 302);
  res = await post(sam, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '2,000', method: 'check', reference: '1042' });
  assert.strictEqual(res.status, 302);

  const saved = db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.id);
  assert.strictEqual(saved.sale_price, 98500);
  assert.strictEqual(saved.financing_type, 'chattel');
  const item = db.prepare('SELECT * FROM deal_items').get();
  assert.strictEqual(item.cost, null, 'sales cannot set add-on cost');
  const pay = db.prepare('SELECT * FROM payments').get();
  assert.strictEqual(pay.amount, 2000);
  assert.strictEqual(pay.received_by, 2);

  const page = await sam.get(`/deals/${deal.id}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Triad Financial/);
  assert.doesNotMatch(page.text, /Gross profit/);
  assert.doesNotMatch(page.text, /71,234/);
  const homePage = await sam.get(`/inventory/${home.id}`);
  assert.doesNotMatch(homePage.text, /71,234|Dealer cost/);
  const listPage = await sam.get('/deals?status=all');
  assert.doesNotMatch(listPage.text, /Gross/);

  const boss = await as(app, 'boss');
  const managerView = await boss.get(`/deals/${deal.id}`);
  assert.match(managerView.text, /Gross profit/);
  assert.match((await boss.get(`/inventory/${home.id}`)).text, /Dealer cost/);

  // Receipt and buyer's order print for anyone.
  assert.strictEqual((await sam.get(`/deals/${deal.id}/payments/${pay.id}/receipt`)).status, 200);
  const print = await sam.get(`/deals/${deal.id}/print`);
  assert.strictEqual(print.status, 200);
  assert.match(print.text, /Delivery &amp; setup/);
});

test('only managers can refund, void, mark sold or cancel', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);
  await post(sam, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '1000', method: 'cash' });

  await post(sam, `/deals/${deal.id}/payments`, { kind: 'refund', amount: '1000', method: 'cash' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM payments WHERE kind = 'refund'").get().n, 0);
  assert.strictEqual((await post(sam, `/deals/${deal.id}/payments/1/void`, { reason: 'x' })).status, 403);
  assert.strictEqual((await post(sam, `/deals/${deal.id}/sold`)).status, 403);
  assert.strictEqual((await post(sam, `/deals/${deal.id}/cancel`, { reason: 'x' })).status, 403);
  assert.strictEqual(db.prepare('SELECT status FROM deals').get().status, 'pending');
});

test('manager marks a deal sold; the deal is then locked for sales', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);
  const boss = await as(app, 'boss');

  await post(boss, `/deals/${deal.id}/sold`);
  assert.strictEqual(db.prepare('SELECT status FROM deals').get().status, 'sold');
  assert.ok(db.prepare('SELECT sold_at FROM deals').get().sold_at);
  assert.strictEqual(db.prepare('SELECT status FROM inventory').get().status, 'sold');
  assert.strictEqual(db.prepare('SELECT lead_status FROM customers').get().lead_status, 'closed');

  await post(sam, `/deals/${deal.id}`, { sale_price: '1', discount: '0', tax_rate: '0', doc_fee: '0' });
  assert.strictEqual(db.prepare('SELECT sale_price FROM deals').get().sale_price, 100000);
  await post(sam, `/deals/${deal.id}/items`, { description: 'Sneaky', price: '1' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM deal_items').get().n, 0);
  // Sales can still record a payment on a sold deal (e.g. the final balance).
  await post(sam, `/deals/${deal.id}/payments`, { kind: 'payment', amount: '5000', method: 'lender' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
});

test('cancelling a deal keeps its history and frees the home for another buyer', async () => {
  const home = addHome(db);
  const first = addCustomer(db);
  const second = addCustomer(db, { first_name: 'Casey', last_name: 'Nguyen' });
  const boss = await as(app, 'boss');
  const deal = await openDeal(boss, db, home, first);
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '1500', method: 'card' });

  assert.strictEqual((await post(boss, `/deals/${deal.id}/cancel`, {})).status, 302);
  assert.strictEqual(db.prepare('SELECT status FROM deals').get().status, 'pending', 'reason required');

  await post(boss, `/deals/${deal.id}/cancel`, { reason: 'Financing fell through' });
  const cancelled = db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.id);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(cancelled.cancel_reason, 'Financing fell through');
  const freed = db.prepare('SELECT * FROM inventory').get();
  assert.strictEqual(freed.status, 'available');
  assert.strictEqual(freed.customer_id, null);

  // Deposit refund on the cancelled deal; new deposits are refused.
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '10', method: 'cash' });
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'refund', amount: '1500', method: 'check' });
  const kinds = db.prepare('SELECT kind FROM payments ORDER BY id').all().map((r) => r.kind);
  assert.deepStrictEqual(kinds, ['deposit', 'refund']);

  const second_deal = await openDeal(boss, db, home, second);
  assert.notStrictEqual(second_deal.id, deal.id);
  const page = await boss.get(`/inventory/${home.id}`);
  assert.match(page.text, /Cancelled deals/);
});

test('refund cannot exceed what was paid, and voided payments stop counting', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const boss = await as(app, 'boss');
  const deal = await openDeal(boss, db, home, customer);
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '500', method: 'cash' });
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'refund', amount: '600', method: 'cash' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM payments WHERE kind='refund'").get().n, 0);

  await post(boss, `/deals/${deal.id}/payments/1/void`, {});
  assert.strictEqual(db.prepare('SELECT voided_at FROM payments').get().voided_at, null, 'reason required');
  await post(boss, `/deals/${deal.id}/payments/1/void`, { reason: 'Check bounced' });
  const p = db.prepare('SELECT * FROM payments').get();
  assert.ok(p.voided_at);
  assert.strictEqual(p.void_reason, 'Check bounced');
  const page = await boss.get(`/deals/${deal.id}`);
  assert.match(page.text, /Voided by Pat Manager/);
});

test('invalid deal input is rejected with a message', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const boss = await as(app, 'boss');
  const deal = await openDeal(boss, db, home, customer);
  const res = await post(boss, `/deals/${deal.id}`, { sale_price: 'lots', discount: '0', tax_rate: '99' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /Sale price must be a valid amount/);
  assert.match(res.text, /Tax rate must be a valid amount/);
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '-5', method: 'cash' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
});
