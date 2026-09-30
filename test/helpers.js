// Shared setup for the test files (not a test file itself).

// Cheap password hashing keeps the suite fast.
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

function setup() {
  const db = openDatabase(':memory:');
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-uploads-'));
  const app = createApp(db, { sessionSecret: 'test-secret', uploadDir });
  const add = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)');
  add.run('boss', 'Pat Manager', hashPassword('manager-pass'), 'manager');
  add.run('sam', 'Sam Sales', hashPassword('sales-pass1'), 'sales');
  add.run('sue', 'Sue Sales', hashPassword('sales-pass2'), 'sales');
  db.prepare("UPDATE users SET commission_plan = 'sales', commission_since = '2020-01-01' WHERE role = 'sales'").run();
  return { db, app, uploadDir };
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(m, 'page should contain a CSRF token');
  return m[1];
}

async function login(app, username, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username, password });
  assert.strictEqual(res.status, 302, `login for ${username} should redirect`);
  const home = await agent.get('/');
  agent.csrf = csrfFrom(home.text);
  return agent;
}

const PASSWORDS = { boss: 'manager-pass', sam: 'sales-pass1', sue: 'sales-pass2' };
const as = (app, username) => login(app, username, PASSWORDS[username]);

function post(agent, url, body = {}) {
  return agent.post(url).type('form').send({ _csrf: agent.csrf, ...body });
}

function addHome(db, overrides = {}) {
  const home = {
    stock_number: 'PH-' + Math.floor(Math.random() * 1e6),
    manufacturer: 'Clayton',
    model: 'Anniversary',
    home_type: 'Double-wide',
    price: 100000,
    invoice_cost: 70000,
    freight_cost: 3000,
    other_cost: null,
    ...overrides,
  };
  const info = db
    .prepare(`INSERT INTO inventory (stock_number, manufacturer, model, home_type, price, invoice_cost, freight_cost, other_cost)
              VALUES (@stock_number, @manufacturer, @model, @home_type, @price, @invoice_cost, @freight_cost, @other_cost)`)
    .run(home);
  return { ...home, id: Number(info.lastInsertRowid) };
}

function addCustomer(db, overrides = {}) {
  const c = { first_name: 'Jordan', last_name: 'Rivera', phone: '555-010-0100', salesperson_id: null, ...overrides };
  const info = db
    .prepare('INSERT INTO customers (first_name, last_name, phone, salesperson_id) VALUES (@first_name, @last_name, @phone, @salesperson_id)')
    .run(c);
  return { ...c, id: Number(info.lastInsertRowid) };
}

// Assign through the real route so the deal is created the same way staff would.
async function openDeal(agent, db, home, customer) {
  const res = await post(agent, '/inventory/assign', { inventory_id: home.id, customer_id: customer.id });
  assert.strictEqual(res.status, 302);
  const deal = db.prepare("SELECT * FROM deals WHERE inventory_id = ? AND status = 'pending'").get(home.id);
  assert.ok(deal, 'assignment should open a deal');
  return deal;
}

module.exports = { setup, csrfFrom, login, as, post, addHome, addCustomer, openDeal, request };
