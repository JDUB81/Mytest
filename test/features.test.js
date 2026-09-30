const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Database = require('better-sqlite3');
const { setup, as, post, addHome, addCustomer, openDeal } = require('./helpers');
const { openDatabase, MIGRATIONS } = require('../src/db');
const { today } = require('../src/deals');

let db;
let app;
let uploadDir;

beforeEach(() => {
  ({ db, app, uploadDir } = setup());
});

// Smallest valid PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('every page renders for both roles with real data', async () => {
  const home = addHome(db, { stock_number: 'SMOKE-1' });
  addHome(db, { stock_number: 'SMOKE-2', invoice_cost: null });
  const customer = addCustomer(db, { salesperson_id: 2 });
  const boss = await as(app, 'boss');
  const deal = await openDeal(boss, db, home, customer);
  await post(boss, `/deals/${deal.id}/items`, { description: 'Skirting', price: '1200', cost: '600', taxable: '1' });
  await post(boss, `/deals/${deal.id}/payments`, { kind: 'deposit', amount: '1000', method: 'cash' });
  await post(boss, '/notes', { customer_id: customer.id, kind: 'call', body: 'Left voicemail' });
  await post(boss, '/notes', { inventory_id: home.id, body: 'Needs touch-up paint' });
  await post(boss, '/tasks', { title: 'Send credit app', due_date: today(), customer_id: customer.id, assigned_to: '2' });
  await post(boss, `/deals/${deal.id}/sold`);

  const shared = [
    '/', '/customers', '/customers?stage=all', '/customers?follow_up=due&owner=me', `/customers/${customer.id}`,
    '/customers/new', `/customers/${customer.id}/edit`, '/inventory', '/inventory?status=all&sort=price_high&beds=2',
    `/inventory/${home.id}`, '/deals', '/deals?status=all&mine=1', `/deals/${deal.id}`, `/deals/${deal.id}/print`,
    `/deals/${deal.id}/payments/1/receipt`, '/tasks', '/tasks?view=all', '/tasks?view=done', '/search?q=zzz',
    '/search?q=Smoke', '/account/password',
  ];
  const managerOnly = [
    '/inventory/new', `/inventory/${home.id}/edit`, `/deals/${deal.id}/edit`, '/reports', '/reports?preset=ytd',
    '/reports?from=2020-01-01&to=2030-12-31', '/reports/activity', '/settings', '/users', '/users/new', '/users/2/edit',
  ];
  const sam = await as(app, 'sam');
  for (const url of [...shared, ...managerOnly]) {
    const res = await boss.get(url);
    assert.strictEqual(res.status, 200, `manager ${url} → ${res.status}`);
  }
  for (const url of shared) {
    const res = await sam.get(url);
    assert.strictEqual(res.status, 200, `sales ${url} → ${res.status}`);
  }
  // The sold deal is closed to sales, so its edit form redirects back to the deal.
  assert.strictEqual((await sam.get(`/deals/${deal.id}/edit`)).status, 302);
});

test('notes build a customer timeline; only the author or a manager can delete one', async () => {
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const sue = await as(app, 'sue');
  await post(sam, '/notes', { customer_id: customer.id, kind: 'visit', body: 'Toured the Anniversary with spouse' });
  await post(sam, '/notes', { customer_id: customer.id, kind: 'note', body: '   ' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 1);

  const page = await sue.get(`/customers/${customer.id}`);
  assert.match(page.text, /Toured the Anniversary with spouse/);
  assert.match(page.text, /Visit \/ showing/);

  assert.strictEqual((await post(sue, '/notes/1/delete')).status, 403);
  assert.strictEqual((await post(sam, '/notes/1/delete')).status, 302);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 0);
});

test('deal notes also appear on the customer timeline', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  const deal = await openDeal(sam, db, home, customer);
  await post(sam, '/notes', { deal_id: deal.id, body: 'Lender wants 2 paystubs' });
  const note = db.prepare('SELECT * FROM notes').get();
  assert.strictEqual(note.customer_id, customer.id);
  assert.strictEqual(note.inventory_id, home.id);
  assert.match((await sam.get(`/customers/${customer.id}`)).text, /Lender wants 2 paystubs/);
  // Assigning the home also wrote history.
  assert.match((await sam.get(`/customers/${customer.id}`)).text, /deal opened/);
});

test('tasks can be assigned, show on the dashboard, and be completed', async () => {
  const customer = addCustomer(db);
  const boss = await as(app, 'boss');
  await post(boss, '/tasks', { title: 'Call about land survey', due_date: today(-1), customer_id: customer.id, assigned_to: '2' });
  await post(boss, '/tasks', { title: '', due_date: today() });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 1);

  const sam = await as(app, 'sam');
  const dash = await sam.get('/');
  assert.match(dash.text, /Call about land survey/);
  assert.match(dash.text, /Overdue/);
  assert.match(dash.text, /class="badge">1</);

  await post(sam, '/tasks/1/done', { from: 'dashboard' });
  assert.ok(db.prepare('SELECT done_at FROM tasks').get().done_at);
  assert.doesNotMatch((await sam.get('/')).text, /Call about land survey/);
  // Sam didn't create it, so Sam can't delete it.
  assert.strictEqual((await post(sam, '/tasks/1/delete')).status, 403);
});

test('customer follow-ups and stage can be set from the profile', async () => {
  const customer = addCustomer(db, { salesperson_id: 2 });
  const sam = await as(app, 'sam');
  await post(sam, `/customers/${customer.id}/quick`, { lead_status: 'appointment', follow_up_date: today() });
  const saved = db.prepare('SELECT * FROM customers').get();
  assert.strictEqual(saved.lead_status, 'appointment');
  assert.strictEqual(saved.follow_up_date, today());
  assert.match((await sam.get('/')).text, /Follow-ups due[\s\S]*Jordan Rivera/);
  const list = await sam.get('/customers?follow_up=due');
  assert.match(list.text, /Rivera, Jordan/);
});

test('reports total sales, profit and commission; exports are CSV with formulas neutralized', async () => {
  const home = addHome(db, { price: 100000, invoice_cost: 70000, freight_cost: 3000 });
  const customer = addCustomer(db, { first_name: '=HYPERLINK("evil")' });
  const boss = await as(app, 'boss');
  await post(boss, '/settings', { business_name: 'Premier Homes', default_tax_rate: '0', default_doc_fee: '0', commission_percent: '25' });
  const deal = await openDeal(boss, db, home, customer);
  await post(boss, `/deals/${deal.id}/sold`);

  const page = await boss.get('/reports');
  assert.match(page.text, /\$27,000/); // gross profit 100000 − 73000
  assert.match(page.text, /\$6,750\.00/); // 25% commission

  const csv = await boss.get('/reports/export/customers.csv');
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /"'=HYPERLINK/);
  const sales = await boss.get(`/reports/export/sales.csv?from=${today()}&to=${today()}`);
  assert.match(sales.text, /27000/);
  assert.strictEqual((await boss.get('/reports/export/inventory.csv')).status, 200);
  assert.strictEqual((await boss.get('/reports/export/payments.csv')).status, 200);
});

test('settings are validated and appear on printed documents', async () => {
  const boss = await as(app, 'boss');
  const bad = await post(boss, '/settings', { business_name: '', default_tax_rate: 'abc' });
  assert.strictEqual(bad.status, 400);
  await post(boss, '/settings', {
    business_name: 'Premier Homes of Tyler',
    business_phone: '903-555-0199',
    default_tax_rate: '0',
    default_doc_fee: '0',
    commission_percent: '0',
    deposit_terms: 'Deposits are refundable within 3 days.',
  });
  const home = addHome(db);
  const customer = addCustomer(db);
  const deal = await openDeal(boss, db, home, customer);
  const print = await boss.get(`/deals/${deal.id}/print`);
  assert.match(print.text, /Premier Homes of Tyler/);
  assert.match(print.text, /903-555-0199/);
  assert.match(print.text, /refundable within 3 days/);
});

test('global search finds customers by phone digits and jumps straight to a single match', async () => {
  const customer = addCustomer(db, { phone: '(903) 555-4242' });
  addCustomer(db, { first_name: 'Other', phone: '111' });
  const sam = await as(app, 'sam');
  const res = await sam.get('/search?q=9035554242');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, `/customers/${customer.id}`);
});

test('managers can upload and remove home photos; staff can view them; sales cannot upload', async () => {
  const home = addHome(db);
  const boss = await as(app, 'boss');
  const up = await boss
    .post(`/inventory/${home.id}/photos?_csrf=${boss.csrf}`)
    .attach('photos', PNG, { filename: 'front.png', contentType: 'image/png' });
  assert.strictEqual(up.status, 302);
  const photo = db.prepare('SELECT * FROM photos').get();
  assert.ok(photo);
  assert.ok(fs.existsSync(`${uploadDir}/${photo.filename}`));

  const sam = await as(app, 'sam');
  const img = await sam.get(`/photos/${photo.id}`);
  assert.strictEqual(img.status, 200);
  assert.match(img.headers['content-type'], /image\/png/);

  const denied = await sam
    .post(`/inventory/${home.id}/photos?_csrf=${sam.csrf}`)
    .attach('photos', PNG, { filename: 'x.png', contentType: 'image/png' });
  assert.strictEqual(denied.status, 403);

  // Non-images are ignored.
  await boss
    .post(`/inventory/${home.id}/photos?_csrf=${boss.csrf}`)
    .attach('photos', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM photos').get().n, 1);

  await post(boss, `/inventory/${home.id}/photos/${photo.id}/delete`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM photos').get().n, 0);
});

test('homes and customers with deal history cannot be deleted', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const boss = await as(app, 'boss');
  const deal = await openDeal(boss, db, home, customer);
  await post(boss, `/deals/${deal.id}/cancel`, { reason: 'Changed mind' });
  await post(boss, `/inventory/${home.id}/delete`);
  await post(boss, `/customers/${customer.id}/delete`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);

  const fresh = addCustomer(db, { first_name: 'Temp' });
  await post(boss, '/notes', { customer_id: fresh.id, body: 'test' });
  await post(boss, `/customers/${fresh.id}/delete`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
});

test('upgrading a first-version database turns assigned homes into deals', () => {
  const file = `${uploadDir}/old.db`;
  const old = new Database(file);
  MIGRATIONS[0](old);
  old.pragma('user_version = 1');
  old.exec(`
    INSERT INTO users (username, full_name, password_hash, role) VALUES ('boss', 'Boss', 'x', 'manager');
    INSERT INTO customers (first_name, last_name, phone) VALUES ('A', 'Buyer', '1'), ('B', 'Owner', '2');
    INSERT INTO inventory (stock_number, manufacturer, model, home_type, price, status, customer_id, assigned_by, assigned_at)
      VALUES ('S1', 'X', 'Y', 'Single-wide', 50000, 'pending', 1, 1, '2026-09-01 10:00:00'),
             ('S2', 'X', 'Z', 'Single-wide', 60000, 'sold', 2, 1, '2026-08-01 10:00:00'),
             ('S3', 'X', 'Q', 'Single-wide', 70000, 'available', NULL, NULL, NULL);
  `);
  old.close();

  const upgraded = openDatabase(file);
  assert.strictEqual(upgraded.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const deals = upgraded.prepare('SELECT inventory_id, customer_id, status, sale_price FROM deals ORDER BY inventory_id').all();
  assert.deepStrictEqual(deals, [
    { inventory_id: 1, customer_id: 1, status: 'pending', sale_price: 50000 },
    { inventory_id: 2, customer_id: 2, status: 'sold', sale_price: 60000 },
  ]);
  const stages = upgraded.prepare('SELECT lead_status FROM customers ORDER BY id').all().map((r) => r.lead_status);
  assert.deepStrictEqual(stages, ['under_contract', 'closed']);
  upgraded.close();
  // Re-opening is a no-op.
  openDatabase(file).close();
});

test('managers can download a database backup; sales cannot', async () => {
  addCustomer(db, { first_name: 'Backed', last_name: 'Up' });
  const boss = await as(app, 'boss');
  const res = await boss.get('/settings/backup').buffer(true).parse((r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-disposition'], /premier-homes-backup-/);
  const file = `${uploadDir}/restored.db`;
  fs.writeFileSync(file, res.body);
  const restored = new Database(file, { readonly: true });
  assert.strictEqual(restored.prepare("SELECT COUNT(*) n FROM customers WHERE first_name = 'Backed'").get().n, 1);
  restored.close();
  const sam = await as(app, 'sam');
  assert.strictEqual((await sam.get('/settings/backup')).status, 403);
});
