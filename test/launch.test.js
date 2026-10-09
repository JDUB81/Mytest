const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, as, post, addHome, addCustomer, openDeal, csrfFrom, request } = require('./helpers');
const { scaleCommission } = require('../src/books');
const { DEFAULT_COMMISSION_SCALE } = require('../src/db');
const { parseModelCode } = require('../src/catalog');

let db;
let app;

beforeEach(() => {
  ({ db, app } = setup());
});

const balance = (userId) =>
  Math.round(db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM commission_entries WHERE user_id = ?').get(userId).b * 100) / 100;

test('Jon Wayne scale: the tier the profit reaches applies to the whole deal', () => {
  const s = DEFAULT_COMMISSION_SCALE;
  assert.deepStrictEqual(scaleCommission(s, 'single', 9000), { rate: 10, amount: 900 });
  assert.deepStrictEqual(scaleCommission(s, 'single', 10000), { rate: 18, amount: 1800 });
  assert.deepStrictEqual(scaleCommission(s, 'single', 14000), { rate: 20, amount: 2800 });
  assert.deepStrictEqual(scaleCommission(s, 'double', 15000), { rate: 18, amount: 2700 });
  assert.deepStrictEqual(scaleCommission(s, 'double', 25000), { rate: 20, amount: 5000 });
  assert.deepStrictEqual(scaleCommission(s, 'double', 31000), { rate: 25, amount: 7750 });
  assert.deepStrictEqual(scaleCommission(s, 'double', -500), { rate: 0, amount: 0 });
});

test('a salesperson on the pay scale earns the scale rate when a deal is sold', async () => {
  db.prepare("UPDATE users SET commission_plan = 'scale' WHERE username = 'sam'").run();
  const boss = await as(app, 'boss');
  const sam = await as(app, 'sam');
  // Double-wide: $100,000 list − $78,000 cost = $22,000 profit → 20% tier = $4,400.
  const home = addHome(db, { price: 100000, invoice_cost: 78000, freight_cost: null });
  const deal = await openDeal(sam, db, home, addCustomer(db));
  await post(boss, `/deals/${deal.id}/sold`);
  assert.strictEqual(balance(2), 4400);
  assert.strictEqual(db.prepare('SELECT commission_plan FROM deals WHERE id = ?').get(deal.id).commission_plan, 'scale');
});

test('manager can edit the pay scale tiers', async () => {
  const boss = await as(app, 'boss');
  const res = await post(boss, '/settings/scale', {
    single_from_0: '0', single_rate_0: '12',
    single_from_1: '10000', single_rate_1: '20',
    double_from_0: '0', double_rate_0: '10',
    double_from_1: '30000', double_rate_1: '30',
    min_single: '8000', min_double: '14000',
  });
  assert.strictEqual(res.status, 302);
  const saved = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'commission_scale'").get().value);
  assert.deepStrictEqual(saved.single, [[0, 12], [10000, 20]]);
  assert.deepStrictEqual(saved.double, [[0, 10], [30000, 30]]);
});

test('monthly expense entry records each account and month close checks recurring accounts', async () => {
  const boss = await as(app, 'boss');
  const page = await boss.get('/books/expenses/enter?month=2026-09');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Advertising/);

  const res = await post(boss, '/books/expenses/enter', {
    month: '2026-09', paid_on: '2026-09-30', method: 'check',
    amount_rent: '1,000', payee_rent: 'Lot owner',
    amount_utilities: '1600',
  });
  assert.strictEqual(res.status, 302);
  const rows = db.prepare('SELECT category, amount, payee_name FROM expenses ORDER BY category').all();
  assert.deepStrictEqual(rows.map((r) => [r.category, r.amount]), [['rent', 1000], ['utilities', 1600]]);
  assert.strictEqual(rows.find((r) => r.category === 'rent').payee_name, 'Lot owner');

  // Other recurring accounts are still missing, so closing needs confirmation.
  await post(boss, '/books/close', { month: '2026-09' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM month_closes').get().n, 0);
  await post(boss, '/books/close', { month: '2026-09', confirm_missing: '1' });
  assert.ok(db.prepare("SELECT 1 FROM month_closes WHERE period = '2026-09'").get());

  const year = await boss.get('/books/expenses?year=2026');
  assert.strictEqual(year.status, 200);
  assert.match(year.text, /1,600/);
});

test('manager can add an expense account with a budget; sales cannot reach expenses', async () => {
  const boss = await as(app, 'boss');
  await post(boss, '/books/accounts', { name: 'Security cameras', kind: 'expense', budget: '75', recurring: '1' });
  const acct = db.prepare("SELECT * FROM expense_accounts WHERE name = 'Security cameras'").get();
  assert.strictEqual(acct.budget, 75);
  assert.strictEqual(acct.recurring, 1);
  const sam = await as(app, 'sam');
  for (const url of ['/books/expenses', '/books/expenses/enter', '/books/close', '/books/accounts']) {
    assert.strictEqual((await sam.get(url)).status, 403, url);
  }
});

test('model codes give width, length and bedrooms', () => {
  assert.deepStrictEqual(parseModelCode('LY32663A'), { width_ft: 32, length_ft: 66, bedrooms: 3 });
  assert.deepStrictEqual(parseModelCode('IH16763A'), { width_ft: 16, length_ft: 76, bedrooms: 3 });
});

test('loading the factory price list adds build-to-order homes once', async () => {
  const boss = await as(app, 'boss');
  await post(boss, '/inventory/import-catalog', { catalog: 'cavco-moultrie-2026-10' });
  const homes = db.prepare("SELECT * FROM inventory WHERE listing = 'order' ORDER BY stock_number").all();
  assert.strictEqual(homes.length, 11);
  const reece = homes.find((h) => h.stock_number === 'ORD-LY32663A');
  assert.strictEqual(reece.price, 144105);
  assert.strictEqual(reece.invoice_cost + reece.freight_cost + reece.other_cost, 129105);
  assert.strictEqual(reece.freight_cost, 9850);
  assert.strictEqual(reece.home_type, 'Double-wide');
  const retreat = homes.find((h) => h.stock_number === 'ORD-LY16642A');
  assert.strictEqual(retreat.freight_cost, 4925);
  assert.strictEqual(retreat.bedrooms, 2);

  await post(boss, '/inventory/import-catalog', { catalog: 'cavco-moultrie-2026-10' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 11);

  const sam = await as(app, 'sam');
  assert.strictEqual((await post(sam, '/inventory/import-catalog', { catalog: 'cavco-moultrie-2026-10' })).status, 403);
});

test('inventory form saves website fields', async () => {
  const boss = await as(app, 'boss');
  await post(boss, '/inventory', {
    stock_number: 'PH-9', manufacturer: 'Destiny', model: 'Reece', home_type: 'Double-wide',
    listing: 'order', featured: '1', show_on_website: '1', web_description: 'Big kitchen.',
  });
  const home = db.prepare("SELECT * FROM inventory WHERE stock_number = 'PH-9'").get();
  assert.strictEqual(home.listing, 'order');
  assert.strictEqual(home.featured, 1);
  assert.strictEqual(home.show_on_website, 1);
  assert.strictEqual(home.web_description, 'Big kitchen.');
});

test('visitors see the public website; staff still get the dashboard', async () => {
  addHome(db, { stock_number: 'WEB-1', model: 'Sunrise', price: 99000, invoice_cost: 61234 });
  const hidden = addHome(db, { stock_number: 'WEB-2', model: 'Hidden Model' });
  db.prepare('UPDATE inventory SET show_on_website = 0 WHERE id = ?').run(hidden.id);

  const home = await request(app).get('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /Sunrise/);
  assert.doesNotMatch(home.text, /Hidden Model/);
  assert.doesNotMatch(home.text, /61,234/);

  const list = await request(app).get('/homes?beds=&max_price=100000');
  assert.match(list.text, /Sunrise/);
  for (const url of ['/financing', '/about', '/contact', '/homes/1']) {
    assert.strictEqual((await request(app).get(url)).status, 200, url);
  }
  assert.strictEqual((await request(app).get(`/homes/${hidden.id}`)).status, 404);

  const boss = await as(app, 'boss');
  const dash = await boss.get('/');
  assert.doesNotMatch(dash.text, /Get pre-qualified/);
  assert.match((await boss.get('/?preview=1')).text, /Get pre-qualified/);
});

test('sold or pending homes and their photos are not public', async () => {
  const h = addHome(db, { stock_number: 'WEB-3', model: 'Gone' });
  db.prepare("UPDATE inventory SET status = 'sold' WHERE id = ?").run(h.id);
  db.prepare("INSERT INTO photos (inventory_id, filename, mime_type) VALUES (?, 'x.jpg', 'image/jpeg')").run(h.id);
  assert.strictEqual((await request(app).get('/media/1')).status, 404);
  assert.doesNotMatch((await request(app).get('/homes')).text, /Gone/);
});

test('a website inquiry creates a lead, a note and a call-back task', async () => {
  const h = addHome(db, { stock_number: 'WEB-4', model: 'Lakeside' });
  const agent = request.agent(app);
  const page = await agent.get(`/homes/${h.id}`);
  const res = await agent.post('/inquire').type('form').send({
    _csrf: csrfFrom(page.text), home_id: h.id, first_name: 'Casey', last_name: 'Buyer',
    phone: '(555) 222-3333', message: 'Is this still available?',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/thanks');
  const c = db.prepare("SELECT * FROM customers WHERE last_name = 'Buyer'").get();
  assert.strictEqual(c.lead_source, 'Website');
  assert.match(db.prepare('SELECT body FROM notes WHERE customer_id = ?').get(c.id).body, /WEB-4[\s\S]*still available/);
  const task = db.prepare('SELECT * FROM tasks WHERE customer_id = ?').get(c.id);
  assert.strictEqual(task.assigned_to, 1);

  // Same phone number again: attaches to the existing customer instead of a duplicate.
  await agent.post('/inquire').type('form').send({
    _csrf: csrfFrom(page.text), first_name: 'Casey', last_name: 'Buyer', phone: '555.222.3333', message: 'Second note',
  });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM notes WHERE customer_id = ?').get(c.id).n, 2);
});

test('inquiries need contact details, ignore bots and are rate limited', async () => {
  const agent = request.agent(app);
  const token = csrfFrom((await agent.get('/contact')).text);
  const bad = await agent.post('/inquire').type('form').send({ _csrf: token, first_name: 'No', last_name: 'Contact' });
  assert.strictEqual(bad.status, 400);
  await agent.post('/inquire').type('form').send({ _csrf: token, first_name: 'Bot', last_name: 'X', phone: '1', website: 'http://spam' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await agent.post('/inquire').type('form').send({ _csrf: token, first_name: 'P', last_name: `N${i}`, email: `p${i}@example.com` });
  }
  assert.strictEqual(last.status, 429);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 5);
});

test('online pre-qualification shows an estimate and starts the credit application', async () => {
  addHome(db, { stock_number: 'WEB-5', model: 'Fits Budget', price: 70000 });
  const agent = request.agent(app);
  const token = csrfFrom((await agent.get('/financing')).text);
  const res = await agent.post('/financing').type('form').send({
    _csrf: token, first_name: 'Dana', last_name: 'Smith', phone: '555-444-1212',
    monthly_income: '5,000', monthly_debts: '400', down_payment: '10000', land_status: 'owns', bedrooms: '3',
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Up to about \$/);
  assert.match(res.text, /Fits Budget/);
  const c = db.prepare("SELECT * FROM customers WHERE last_name = 'Smith'").get();
  assert.strictEqual(c.land_status, 'owns');
  assert.strictEqual(c.desired_bedrooms, 3);
  assert.ok(c.budget > 0);
  const app_ = JSON.parse(db.prepare('SELECT data FROM credit_apps WHERE customer_id = ?').get(c.id).data);
  assert.strictEqual(app_.a_monthly_income, 5000);
  assert.strictEqual(app_.down_payment, 10000);

  const missing = await agent.post('/financing').type('form').send({ _csrf: token, first_name: 'A', last_name: 'B', phone: '1' });
  assert.strictEqual(missing.status, 400);
});
