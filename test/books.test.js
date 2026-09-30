const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, as, post, addHome, addCustomer, openDeal } = require('./helpers');
const { amountInWords, previousMonth, syncGmCommissions } = require('../src/books');
const { today } = require('../src/deals');

let db;
let app;

beforeEach(() => {
  ({ db, app } = setup());
});

const balance = (userId) =>
  Math.round(db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM commission_entries WHERE user_id = ?').get(userId).b * 100) / 100;
const entries = (userId) => db.prepare('SELECT kind, amount FROM commission_entries WHERE user_id = ? ORDER BY id').all(userId);

async function addVendor(agent, name = 'Cool Air HVAC') {
  await post(agent, '/books/vendors', { name, trade: 'HVAC', address: '1 Main St' });
  return db.prepare('SELECT * FROM vendors WHERE name = ?').get(name);
}

// Home $100,000 list / $70,000 cost, plus an A/C add-on sold at $4,200 with $2,900 allotted.
// Gross profit = 100,000 + 4,200 − 70,000 − 2,900 = $31,300. Sam (sales, 25%) earns $7,825.
async function soldDealWithAc({ sell = true } = {}) {
  const boss = await as(app, 'boss');
  await post(boss, '/settings/addons', { name: 'Central A/C', price: '4200', cost: '2900', taxable: '1' });
  const ac = db.prepare('SELECT * FROM addon_catalog').get();
  const home = addHome(db, { price: 100000, invoice_cost: 70000, freight_cost: null });
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);
  await post(sam, `/deals/${deal.id}/items`, { catalog_id: ac.id, description: '', price: '', taxable: '1' });
  const item = db.prepare('SELECT * FROM deal_items WHERE deal_id = ?').get(deal.id);
  if (sell) await post(boss, `/deals/${deal.id}/sold`);
  return { boss, sam, deal, item, home, customer, ac };
}

test('amounts are written out in words for checks', () => {
  assert.strictEqual(amountInWords(3400), 'Three thousand four hundred and 00/100');
  assert.strictEqual(amountInWords(1234.56), 'One thousand two hundred thirty-four and 56/100');
  assert.strictEqual(amountInWords(90.07), 'Ninety and 07/100');
});

test('price list fills in price and allotted cost; sales cannot see or override cost', async () => {
  const { sam, deal, item, ac } = await soldDealWithAc({ sell: false });
  assert.strictEqual(item.description, 'Central A/C');
  assert.strictEqual(item.price, 4200);
  assert.strictEqual(item.cost, 2900);
  assert.strictEqual(item.catalog_id, ac.id);

  // Sales changes the price but tries to sneak a cost in: the price list's cost applies.
  await post(sam, `/deals/${deal.id}/items`, { catalog_id: ac.id, description: 'A/C upgrade', price: '4500', cost: '1', taxable: '1' });
  const second = db.prepare('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY id DESC').get(deal.id);
  assert.strictEqual(second.price, 4500);
  assert.strictEqual(second.cost, 2900);
  assert.strictEqual(second.description, 'A/C upgrade');

  const page = await sam.get(`/deals/${deal.id}`);
  assert.match(page.text, /Central A\/C — \$4,200/);
  assert.doesNotMatch(page.text, /data-cost|2,900|Job costs/);
  assert.strictEqual((await sam.get('/settings/addons')).status, 403);
  assert.strictEqual((await sam.get('/books/register')).status, 403);
});

test('managers can override the preset price and cost, and edit a line later', async () => {
  const { boss, deal, ac } = await soldDealWithAc({ sell: false });
  await post(boss, `/deals/${deal.id}/items`, { catalog_id: ac.id, description: 'Central A/C', price: '3900', cost: '2600', taxable: '1' });
  const row = db.prepare('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY id DESC').get(deal.id);
  assert.strictEqual(row.price, 3900);
  assert.strictEqual(row.cost, 2600);
  await post(boss, `/deals/${deal.id}/items/${row.id}`, { description: 'Central A/C 3-ton', price: '4000', cost: '2700', taxable: '1' });
  const edited = db.prepare('SELECT * FROM deal_items WHERE id = ?').get(row.id);
  assert.deepStrictEqual([edited.description, edited.price, edited.cost], ['Central A/C 3-ton', 4000, 2700]);
});

test('selling a deal credits the salesperson 25% of gross profit', async () => {
  await soldDealWithAc();
  assert.deepStrictEqual(entries(2), [{ kind: 'earned', amount: 7825 }]);
  const deal = db.prepare('SELECT * FROM deals').get();
  assert.strictEqual(deal.commission_user_id, 2);
  assert.strictEqual(deal.commission_rate, 25);
});

test('the check form shows what is allotted for each job on the chosen deal', async () => {
  const { boss, deal } = await soldDealWithAc();
  const vendor = await addVendor(boss);
  const page = await boss.get(`/books/checks/new?deal_id=${deal.id}&vendor_id=${vendor.id}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Which job are you paying for/);
  assert.match(page.text, /Central A\/C[\s\S]*allotted <strong>\$2,900\.00/);
  assert.match(page.text, /data-rate="25"/);
});

test('paying more than allotted charges 25% of the overrun back to the salesperson; voiding undoes it', async () => {
  const { boss, deal, item } = await soldDealWithAc();
  const vendor = await addVendor(boss);

  let res = await post(boss, '/books/checks', {
    deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id,
    amount: '2,000', paid_on: today(), method: 'check', check_number: '',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(balance(2), 7825, 'within allotment: no change');

  res = await post(boss, '/books/checks', {
    deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id,
    amount: '1400', paid_on: today(), method: 'check',
  });
  // 2,000 + 1,400 = 3,400 paid vs 2,900 allotted → $500 over → 25% = $125 charge-back.
  assert.deepStrictEqual(entries(2), [{ kind: 'earned', amount: 7825 }, { kind: 'overrun', amount: -125 }]);
  assert.strictEqual(balance(2), 7700);

  const checks = db.prepare('SELECT * FROM expenses ORDER BY id').all();
  assert.deepStrictEqual(checks.map((c) => c.check_number), ['1001', '1002'], 'check numbers auto-increment');
  assert.strictEqual(checks[0].category, 'job');

  const dealPage = await boss.get(`/deals/${deal.id}`);
  assert.match(dealPage.text, /\$500\.00 over/);
  assert.match(dealPage.text, /charge-back/);

  await post(boss, `/books/checks/${checks[1].id}/void`, { reason: 'Wrong amount' });
  assert.strictEqual(balance(2), 7825);
  assert.deepStrictEqual(entries(2).map((e) => e.kind), ['earned', 'overrun', 'overrun']);
});

test('overruns on a pending deal are charged when it is sold', async () => {
  const { boss, deal, item } = await soldDealWithAc({ sell: false });
  const vendor = await addVendor(boss);
  await post(boss, '/books/checks', {
    deal_id: deal.id, deal_item_id: 'misc', payee_type: 'vendor', vendor_id: vendor.id,
    amount: '400', paid_on: today(), method: 'ach',
  });
  assert.strictEqual(balance(2), 0, 'nothing earned until sold');
  await post(boss, `/deals/${deal.id}/sold`);
  // Unbudgeted $400 → $100 charge-back.
  assert.deepStrictEqual(entries(2), [{ kind: 'earned', amount: 7825 }, { kind: 'overrun', amount: -100 }]);
  // Cancelling the sale reverses both.
  await post(boss, `/deals/${deal.id}/cancel`, { reason: 'Backed out' });
  assert.strictEqual(balance(2), 0);
  assert.ok(item);
});

test('changing a sold deal recalculates commission with a traceable adjustment', async () => {
  const { boss, deal } = await soldDealWithAc();
  await post(boss, `/deals/${deal.id}`, {
    sale_price: '99000', discount: '0', tax_rate: '0', doc_fee: '0', trade_allowance: '0', trade_payoff: '0', salesperson_id: '2',
  });
  // Gross profit drops by $1,000 → commission drops by $250.
  assert.deepStrictEqual(entries(2), [{ kind: 'earned', amount: 7825 }, { kind: 'earned', amount: -250 }]);
});

test('job checks must name a deal and a job; duplicate check numbers are refused', async () => {
  const { boss, deal } = await soldDealWithAc();
  const vendor = await addVendor(boss);
  let res = await post(boss, '/books/checks', { deal_id: deal.id, payee_type: 'vendor', vendor_id: vendor.id, amount: '10', paid_on: today(), method: 'check' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /Pick which job/);
  res = await post(boss, '/books/checks', { category: 'job', payee_type: 'vendor', vendor_id: vendor.id, amount: '10', paid_on: today(), method: 'check' });
  assert.strictEqual(res.status, 400);
  await post(boss, '/books/checks', { category: 'rent', payee_type: 'other', payee_name: 'Landlord LLC', amount: '2000', paid_on: today(), method: 'check', check_number: '5000' });
  res = await post(boss, '/books/checks', { category: 'rent', payee_type: 'other', payee_name: 'Landlord LLC', amount: '2000', paid_on: today(), method: 'check', check_number: '5000' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /already in the register/);
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'next_check_number'").get().value, '5001');
});

test('an add-on with checks written against it cannot be removed from the deal', async () => {
  const { boss, deal, item } = await soldDealWithAc();
  const vendor = await addVendor(boss);
  await post(boss, '/books/checks', { deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id, amount: '100', paid_on: today(), method: 'cash' });
  await post(boss, `/deals/${deal.id}/items/${item.id}/delete`);
  assert.ok(db.prepare('SELECT id FROM deal_items WHERE id = ?').get(item.id));
});

test('paying commission by check reduces the balance; voiding the check restores it', async () => {
  const { boss } = await soldDealWithAc();
  const form = await boss.get('/books/checks/new?payee_user_id=2');
  assert.match(form.text, /value="commission" selected/);
  await post(boss, '/books/checks', { category: 'commission', payee_type: 'staff', payee_user_id: '2', amount: '5000', paid_on: today(), method: 'check' });
  assert.strictEqual(balance(2), 2825);
  const check = db.prepare("SELECT * FROM expenses WHERE category = 'commission'").get();
  await post(boss, `/books/checks/${check.id}/void`, { reason: 'Lost in mail' });
  assert.strictEqual(balance(2), 7825);

  const print = await boss.get(`/books/checks/${check.id}/print`);
  assert.match(print.text, /Five thousand and 00\/100/);
  assert.match(print.text, /Sam Sales/);
});

test('salespeople see their own ledger without profit figures', async () => {
  const { boss, deal, item } = await soldDealWithAc();
  const vendor = await addVendor(boss);
  await post(boss, '/books/checks', { deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id, amount: '3400', paid_on: today(), method: 'check' });
  const sam = await as(app, 'sam');
  const page = await sam.get('/my/commissions');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /\$7,700\.00/);
  assert.match(page.text, /job costs over allotment/);
  assert.doesNotMatch(page.text, /31,300|30,800/);
  assert.match((await sam.get('/')).text, /My commission/);
});

test('general manager earns 35% of a closed month\'s net profit, adjusted later if the month changes', async () => {
  const { boss, deal, item } = await soldDealWithAc();
  const last = previousMonth(today().slice(0, 7));
  // Move the sale into last month and record last month's rent.
  db.prepare("UPDATE deals SET sold_at = ? WHERE id = ?").run(`${last}-15 18:00:00`, deal.id);
  await post(boss, '/books/checks', { category: 'rent', payee_type: 'other', payee_name: 'Landlord LLC', amount: '2000', paid_on: `${last}-01`, method: 'check' });
  await post(boss, '/users/1', {
    full_name: 'Pat Manager', role: 'manager', active: '1', commission_plan: 'gm', commission_rate: '', commission_since: `${last}-01`,
  });

  const page = await boss.get('/books/commissions');
  assert.strictEqual(page.status, 200);
  // Net = 31,300 gross − 7,825 sales commission − 2,000 rent = 21,475 → 35% = 7,516.25
  assert.deepStrictEqual(entries(1), [{ kind: 'gm', amount: 7516.25 }]);

  // A job on last month's deal goes $500 over (paid this month).
  const vendor = await addVendor(boss);
  await post(boss, '/books/checks', { deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id, amount: '3400', paid_on: today(), method: 'check' });
  syncGmCommissions(db);
  // Net = 31,300 − 500 − 7,700 − 2,000 = 21,100 → 7,385 → adjustment of −131.25
  assert.deepStrictEqual(entries(1), [{ kind: 'gm', amount: 7516.25 }, { kind: 'gm', amount: -131.25 }]);
  syncGmCommissions(db);
  assert.strictEqual(entries(1).length, 2, 'sync is idempotent');

  const pl = await boss.get(`/books/profit?month=${last}`);
  assert.match(pl.text, /\$21,100/);
});

test('every books page renders', async () => {
  const { boss, deal, item } = await soldDealWithAc();
  const vendor = await addVendor(boss);
  await post(boss, '/books/checks', { deal_id: deal.id, deal_item_id: item.id, payee_type: 'vendor', vendor_id: vendor.id, amount: '3000', paid_on: today(), method: 'check' });
  for (const url of [
    '/books', '/books/register', '/books/register?month=all&category=job', '/books/checks/new', `/books/checks/new?deal_id=${deal.id}`,
    '/books/checks/1', '/books/checks/1/print', '/books/vendors', '/books/vendors/new', `/books/vendors/${vendor.id}`,
    `/books/vendors/${vendor.id}/edit`, '/books/jobs', '/books/jobs?status=all&over=1', '/books/commissions', '/books/commissions/2',
    '/books/profit', '/settings/addons', '/users/2/edit', '/users/new', '/users', `/deals/${deal.id}`,
  ]) {
    const res = await boss.get(url);
    assert.ok([200, 302].includes(res.status), `${url} → ${res.status}`);
    if (url !== '/books') assert.strictEqual(res.status, 200, url);
  }
});
