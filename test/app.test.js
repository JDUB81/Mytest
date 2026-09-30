const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

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
};

beforeEach(() => {
  db = openDatabase(':memory:');
  app = createApp(db, { sessionSecret: 'test-secret' });
  const add = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)');
  add.run('boss', 'Pat Manager', hashPassword('manager-pass'), 'manager');
  add.run('sam', 'Sam Sales', hashPassword('sales-pass1'), 'sales');
});

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(m, 'page should contain a CSRF token');
  return m[1];
}

async function login(username, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username, password });
  assert.strictEqual(res.status, 302, `login for ${username} should redirect`);
  const home = await agent.get('/');
  agent.csrf = csrfFrom(home.text);
  return agent;
}

function post(agent, url, body = {}) {
  return agent.post(url).type('form').send({ _csrf: agent.csrf, ...body });
}

test('unauthenticated users are sent to the login page', async () => {
  const res = await request(app).get('/inventory');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/login');
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

test('POST without a CSRF token is rejected', async () => {
  const agent = await login('boss', 'manager-pass');
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

test('manager can add inventory', async () => {
  const agent = await login('boss', 'manager-pass');
  const res = await post(agent, '/inventory', HOME);
  assert.strictEqual(res.status, 302);
  const row = db.prepare('SELECT * FROM inventory').get();
  assert.strictEqual(row.stock_number, 'PH-1001');
  assert.strictEqual(row.price, 89900);
  assert.strictEqual(row.square_feet, 1560);
  assert.strictEqual(row.status, 'available');

  const dup = await post(agent, '/inventory', HOME);
  assert.strictEqual(dup.status, 400);
  assert.match(dup.text, /already in use/);
});

test('sales associate cannot add, edit or delete inventory or manage staff', async () => {
  db.prepare("INSERT INTO inventory (stock_number, manufacturer, model, home_type) VALUES ('A1','X','Y','Single-wide')").run();
  const agent = await login('sam', 'sales-pass1');
  assert.strictEqual((await agent.get('/inventory/new')).status, 403);
  assert.strictEqual((await post(agent, '/inventory', HOME)).status, 403);
  assert.strictEqual((await post(agent, '/inventory/1', HOME)).status, 403);
  assert.strictEqual((await post(agent, '/inventory/1/delete')).status, 403);
  assert.strictEqual((await agent.get('/users')).status, 403);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 1);

  const list = await agent.get('/inventory');
  assert.doesNotMatch(list.text, /Add inventory/);
});

test('sales associate can add customers, view inventory and assign a home', async () => {
  db.prepare(
    "INSERT INTO inventory (stock_number, manufacturer, model, home_type, price) VALUES ('PH-7','Champion','Aspen','Single-wide', 64000)"
  ).run();
  const agent = await login('sam', 'sales-pass1');

  const created = await post(agent, '/customers', {
    first_name: 'Jordan',
    last_name: 'Rivera',
    phone: '555-0100',
  });
  assert.strictEqual(created.status, 302);
  const customer = db.prepare('SELECT * FROM customers').get();
  assert.strictEqual(customer.last_name, 'Rivera');

  const list = await agent.get('/inventory');
  assert.match(list.text, /PH-7/);

  const assigned = await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: customer.id });
  assert.strictEqual(assigned.status, 302);
  const home = db.prepare('SELECT * FROM inventory WHERE id = 1').get();
  assert.strictEqual(home.customer_id, customer.id);
  assert.strictEqual(home.status, 'pending');

  // No longer available: a second assignment must not steal it.
  db.prepare("INSERT INTO customers (first_name, last_name, phone) VALUES ('Other','Person','1')").run();
  await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: 2 });
  assert.strictEqual(db.prepare('SELECT customer_id FROM inventory WHERE id = 1').get().customer_id, customer.id);

  // Sales can't release or mark sold.
  assert.strictEqual((await post(agent, '/inventory/1/release')).status, 403);
  assert.strictEqual((await post(agent, '/inventory/1/sold')).status, 403);
});

test('assigning to a customer that does not exist fails', async () => {
  db.prepare("INSERT INTO inventory (stock_number, manufacturer, model, home_type) VALUES ('A1','X','Y','Single-wide')").run();
  const agent = await login('sam', 'sales-pass1');
  await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: 999 });
  const home = db.prepare('SELECT * FROM inventory WHERE id = 1').get();
  assert.strictEqual(home.customer_id, null);
  assert.strictEqual(home.status, 'available');
});

test('customer requires a name and a way to contact them', async () => {
  const agent = await login('sam', 'sales-pass1');
  const res = await post(agent, '/customers', { first_name: 'No', last_name: 'Contact' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /phone number or email/);
});

test('manager can mark an assigned home sold and release it', async () => {
  db.prepare("INSERT INTO customers (first_name, last_name, phone) VALUES ('A','B','1')").run();
  db.prepare("INSERT INTO inventory (stock_number, manufacturer, model, home_type) VALUES ('A1','X','Y','Single-wide')").run();
  const agent = await login('boss', 'manager-pass');
  await post(agent, '/inventory/assign', { inventory_id: 1, customer_id: 1 });
  await post(agent, '/inventory/1/sold');
  assert.strictEqual(db.prepare('SELECT status FROM inventory').get().status, 'sold');
  await post(agent, '/inventory/1/release');
  const home = db.prepare('SELECT * FROM inventory').get();
  assert.strictEqual(home.status, 'available');
  assert.strictEqual(home.customer_id, null);
});

test('manager can create a sales account that can then sign in', async () => {
  const agent = await login('boss', 'manager-pass');
  const res = await post(agent, '/users', {
    full_name: 'New Hire',
    username: 'newhire',
    role: 'sales',
    password: 'welcome-123',
    confirm: 'welcome-123',
  });
  assert.strictEqual(res.status, 302);
  await login('newhire', 'welcome-123');
});

test('disabled accounts cannot sign in and lose their session', async () => {
  const sales = await login('sam', 'sales-pass1');
  const boss = await login('boss', 'manager-pass');
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
  const boss = await login('boss', 'manager-pass');
  const res = await post(boss, '/users/1', { full_name: 'Pat Manager', role: 'sales', active: '1' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(db.prepare('SELECT role FROM users WHERE id = 1').get().role, 'manager');
});

test('user-entered text is HTML-escaped', async () => {
  const agent = await login('sam', 'sales-pass1');
  await post(agent, '/customers', { first_name: '<script>alert(1)</script>', last_name: 'X', phone: '1' });
  const page = await agent.get('/customers');
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;/);
});
