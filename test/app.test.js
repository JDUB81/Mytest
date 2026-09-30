const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, csrfFrom, login, as, post, request } = require('./helpers');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let db;
let app;

const HOME = {
  stock_number: 'PH-1001',
  manufacturer: 'Clayton',
  model: 'The Anniversary',
  year: '2026',
  home_type: 'Double-wide',
  bedrooms: '3',
  bathrooms: '2',
  square_feet: '1,560',
  price: '$89,900',
  invoice_cost: '61,000',
};

beforeEach(() => {
  ({ db, app } = setup());
});

test('unauthenticated users are sent to the login page', async () => {
  for (const url of ['/', '/inventory', '/customers', '/deals', '/tasks', '/reports', '/photos/1']) {
    const res = await request(app).get(url);
    assert.strictEqual(res.status, 302, url);
    assert.strictEqual(res.headers.location, '/login', url);
  }
});

test('health check answers without signing in', async () => {
  const res = await request(app).get('/healthz');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, 'ok');
});

test('bad password is rejected', async () => {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username: 'boss', password: 'wrong-password' });
  assert.strictEqual(res.status, 401);
  assert.match(res.text, /Invalid username or password/);
});

test('repeated failed logins lock the account temporarily', async () => {
  const agent = request.agent(app);
  const token = csrfFrom((await agent.get('/login')).text);
  for (let i = 0; i < 5; i++) {
    await agent.post('/login').type('form').send({ _csrf: token, username: 'sam', password: 'nope-nope' });
  }
  const res = await agent.post('/login').type('form').send({ _csrf: token, username: 'sam', password: 'sales-pass1' });
  assert.strictEqual(res.status, 429);
});

test('POST without a CSRF token is rejected', async () => {
  const agent = await as(app, 'boss');
  const res = await agent.post('/inventory').type('form').send(HOME);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 0);
});

test('first-run setup creates a manager only when no users exist', async () => {
  const emptyDb = openDatabase(':memory:');
  const freshApp = createApp(emptyDb, { sessionSecret: 'x' });
  const agent = request.agent(freshApp);
  assert.strictEqual((await agent.get('/login')).headers.location, '/setup');
  const page = await agent.get('/setup');
  const res = await agent.post('/setup').type('form').send({
    _csrf: csrfFrom(page.text),
    full_name: 'Owner',
    username: 'owner',
    password: 'owner-pass',
    confirm: 'owner-pass',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(emptyDb.prepare('SELECT role FROM users').get().role, 'manager');
  assert.strictEqual((await request(freshApp).get('/setup')).headers.location, '/login');
});

test('manager can add inventory, including dealer cost', async () => {
  const agent = await as(app, 'boss');
  const res = await post(agent, '/inventory', HOME);
  assert.strictEqual(res.status, 302);
  const row = db.prepare('SELECT * FROM inventory').get();
  assert.strictEqual(row.stock_number, 'PH-1001');
  assert.strictEqual(row.price, 89900);
  assert.strictEqual(row.square_feet, 1560);
  assert.strictEqual(row.invoice_cost, 61000);
  assert.strictEqual(row.status, 'available');

  const dup = await post(agent, '/inventory', HOME);
  assert.strictEqual(dup.status, 400);
  assert.match(dup.text, /already in use/);
});

test('sales associate cannot add, edit or delete inventory or reach manager pages', async () => {
  db.prepare("INSERT INTO inventory (stock_number, manufacturer, model, home_type) VALUES ('A1','X','Y','Single-wide')").run();
  const agent = await as(app, 'sam');
  assert.strictEqual((await agent.get('/inventory/new')).status, 403);
  assert.strictEqual((await post(agent, '/inventory', HOME)).status, 403);
  assert.strictEqual((await post(agent, '/inventory/1', HOME)).status, 403);
  assert.strictEqual((await post(agent, '/inventory/1/delete')).status, 403);
  for (const url of ['/users', '/reports', '/reports/activity', '/settings', '/reports/export/customers.csv']) {
    assert.strictEqual((await agent.get(url)).status, 403, url);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 1);

  const list = await agent.get('/inventory');
  assert.doesNotMatch(list.text, /Add inventory/);
});

test('sales associate can add customers, view inventory and assign a home', async () => {
  db.prepare(
    "INSERT INTO inventory (stock_number, manufacturer, model, home_type, price) VALUES ('PH-7','Champion','Aspen','Single-wide', 64000)"
  ).run();
  const agent = await as(app, 'sam');

  const created = await post(agent, '/customers', {
    first_name: 'Jordan',
    last_name: 'Rivera',
    phone: '555-0100',
    lead_source: 'Facebook',
    salesperson_id: '2',
  });
  assert.strictEqual(created.status, 302);
  const customer = db.prepare('SELECT * FROM customers').get();
  assert.strictEqual(customer.last_name, 'Rivera');
  assert.strictEqual(customer.lead_source, 'Facebook');
  assert.strictEqual(customer.salesperson_id, 2);

  const list = await agent.get('/inventory');
  assert.match(list.text, /PH-7/);

  const assigned = await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: customer.id });
  assert.strictEqual(assigned.status, 302);
  assert.match(assigned.headers.location, /^\/deals\/\d+$/);
  const home = db.prepare('SELECT * FROM inventory WHERE id = 1').get();
  assert.strictEqual(home.customer_id, customer.id);
  assert.strictEqual(home.status, 'pending');
  assert.strictEqual(db.prepare('SELECT lead_status FROM customers').get().lead_status, 'under_contract');

  // No longer available: a second assignment must not steal it.
  db.prepare("INSERT INTO customers (first_name, last_name, phone) VALUES ('Other','Person','1')").run();
  await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: 2 });
  assert.strictEqual(db.prepare('SELECT customer_id FROM inventory WHERE id = 1').get().customer_id, customer.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM deals').get().n, 1);
});

test('assigning to a customer that does not exist fails', async () => {
  db.prepare("INSERT INTO inventory (stock_number, manufacturer, model, home_type) VALUES ('A1','X','Y','Single-wide')").run();
  const agent = await as(app, 'sam');
  await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: 999 });
  const home = db.prepare('SELECT * FROM inventory WHERE id = 1').get();
  assert.strictEqual(home.customer_id, null);
  assert.strictEqual(home.status, 'available');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM deals').get().n, 0);
});

test('customer requires a name and a way to contact them', async () => {
  const agent = await as(app, 'sam');
  const res = await post(agent, '/customers', { first_name: 'No', last_name: 'Contact' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /phone number or email/);
});

test('manager can create a sales account that can then sign in', async () => {
  const agent = await as(app, 'boss');
  const res = await post(agent, '/users', {
    full_name: 'New Hire',
    username: 'newhire',
    role: 'sales',
    password: 'welcome-123',
    confirm: 'welcome-123',
  });
  assert.strictEqual(res.status, 302);
  await login(app, 'newhire', 'welcome-123');
});

test('disabled accounts cannot sign in and lose their session', async () => {
  const sales = await as(app, 'sam');
  const boss = await as(app, 'boss');
  await post(boss, '/users/2', { full_name: 'Sam Sales', role: 'sales' }); // active unchecked
  assert.strictEqual((await sales.get('/customers')).headers.location, '/login');

  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username: 'sam', password: 'sales-pass1' });
  assert.strictEqual(res.status, 401);
});

test('manager cannot demote themselves', async () => {
  const boss = await as(app, 'boss');
  const res = await post(boss, '/users/1', { full_name: 'Pat Manager', role: 'sales', active: '1' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(db.prepare('SELECT role FROM users WHERE id = 1').get().role, 'manager');
});

test('user-entered text is HTML-escaped', async () => {
  const agent = await as(app, 'sam');
  await post(agent, '/customers', { first_name: '<script>alert(1)</script>', last_name: 'X', phone: '1' });
  const page = await agent.get('/customers');
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;/);
});

test('users can change their own password', async () => {
  const agent = await as(app, 'sam');
  const res = await post(agent, '/account/password', { current: 'sales-pass1', password: 'brand-new-pass', confirm: 'brand-new-pass' });
  assert.strictEqual(res.status, 302);
  await login(app, 'sam', 'brand-new-pass');
});
