const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, as, post, addHome, addCustomer } = require('./helpers');
const { estimateBudget } = require('../src/credit');

let db;
let app;

beforeEach(() => {
  ({ db, app } = setup());
});

const pv = (payment, ratePct, months) => {
  const r = ratePct / 100 / 12;
  return Math.round(((payment * (1 - Math.pow(1 + r, -months))) / r) * 100) / 100;
};

test('the jobs list starts with the common jobs, grouped by category', async () => {
  const names = db.prepare('SELECT name, category FROM addon_catalog').all();
  assert.ok(names.length >= 25);
  for (const expected of ['Central A/C', 'Heat pump', 'Vinyl skirting', 'Deck', 'Septic system', 'Permits']) {
    assert.ok(names.some((n) => n.name === expected), `${expected} is on the list`);
  }
  assert.strictEqual(names.find((n) => n.name === 'Central A/C').category, 'HVAC');

  const home = addHome(db);
  const customer = addCustomer(db);
  const boss = await as(app, 'boss');
  await post(boss, '/inventory/assign', { inventory_id: home.id, customer_id: customer.id });
  const page = await boss.get('/deals/1');
  assert.match(page.text, /<optgroup label="HVAC">[\s\S]*Central A\/C/);
});

test('one place to set a job\'s price, cost, category and default vendor', async () => {
  const boss = await as(app, 'boss');
  await post(boss, '/books/vendors', { name: 'Cool Air HVAC', trade: 'HVAC' });
  const vendor = db.prepare('SELECT id FROM vendors').get();
  const ac = db.prepare("SELECT * FROM addon_catalog WHERE name = 'Central A/C'").get();
  await post(boss, `/settings/addons/${ac.id}`, { name: 'Central A/C', category: 'HVAC', price: '4200', cost: '2900', vendor_id: vendor.id, taxable: '1', active: '1' });
  const saved = db.prepare('SELECT * FROM addon_catalog WHERE id = ?').get(ac.id);
  assert.deepStrictEqual([saved.price, saved.cost, saved.vendor_id], [4200, 2900, vendor.id]);

  // Used on a deal, then paying for that job pre-selects the vendor.
  const home = addHome(db);
  const customer = addCustomer(db);
  await post(boss, '/inventory/assign', { inventory_id: home.id, customer_id: customer.id });
  await post(boss, '/deals/1/items', { catalog_id: ac.id, description: '', price: '', cost: '', taxable: '1' });
  const item = db.prepare('SELECT * FROM deal_items').get();
  assert.deepStrictEqual([item.price, item.cost], [4200, 2900]);
  const form = await boss.get('/books/checks/new?deal_id=1');
  assert.match(form.text, new RegExp(`value="${item.id}"[^>]*data-vendor="${vendor.id}"`));

  const sam = await as(app, 'sam');
  assert.strictEqual((await sam.get('/settings/addons')).status, 403);
});

test('a job with no price yet leaves the price for the salesperson to type', async () => {
  const home = addHome(db);
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  await post(sam, '/inventory/assign', { inventory_id: home.id, customer_id: customer.id });
  const deck = db.prepare("SELECT * FROM addon_catalog WHERE name = 'Deck'").get();
  await post(sam, '/deals/1/items', { catalog_id: deck.id, description: '', price: '', taxable: '1' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM deal_items').get().n, 0, 'rejected without a price');
  await post(sam, '/deals/1/items', { catalog_id: deck.id, description: '', price: '3200', taxable: '1' });
  const item = db.prepare('SELECT * FROM deal_items').get();
  assert.deepStrictEqual([item.description, item.price], ['Deck', 3200]);
});

test('budget formula: DTI room minus debts, lot rent and insurance, turned into a loan plus down payment', () => {
  const profile = { name: 'Test', dti_max: 43, pti_max: null, rate: 9.99, term_months: 240, min_down_percent: 0 };
  const data = { a_monthly_income: 4000, c_monthly_income: 1000, a_debt_auto: 400, c_debt_cards: 100, lot_rent: 0, down_payment: 5000 };
  const r = estimateBudget(data, profile, { insuranceMonthly: 100 });
  // 43% × 5,000 = 2,150 − 500 debts − 100 insurance = 1,550/mo
  assert.strictEqual(r.income, 5000);
  assert.strictEqual(r.debts, 500);
  assert.strictEqual(r.payment, 1550);
  assert.strictEqual(r.loan, pv(1550, 9.99, 240));
  assert.strictEqual(r.maxPrice, Math.round((pv(1550, 9.99, 240) + 5000) * 100) / 100);

  // PTI cap and minimum down payment both limit the result.
  const capped = estimateBudget(data, { ...profile, pti_max: 25, min_down_percent: 5 }, { insuranceMonthly: 100 });
  assert.strictEqual(capped.payment, 1150); // min(1,650, 1,250) − 100
  assert.strictEqual(capped.maxPrice, 100000); // $5,000 is 5% of $100,000
  assert.ok(capped.limitedByDown);

  assert.ok(estimateBudget({}, profile).incomplete);
  assert.strictEqual(estimateBudget({ a_monthly_income: 1000, a_debt_auto: 900 }, profile).payment, 0);
});

test('credit application pre-fills from the customer, encrypts the SSN, and prints', async () => {
  const customer = addCustomer(db);
  db.prepare("UPDATE customers SET co_buyer_name = 'Taylor Ann Rivera', land_status = 'owns', land_location = 'FM 2767' WHERE id = ?").run(customer.id);
  const sam = await as(app, 'sam');

  const blank = await sam.get(`/customers/${customer.id}/credit`);
  assert.strictEqual(blank.status, 200);
  assert.match(blank.text, /name="a_first_name" value="Jordan"/);
  assert.match(blank.text, /name="c_first_name" value="Taylor"/);
  assert.match(blank.text, /name="c_last_name" value="Ann Rivera"/);
  assert.match(blank.text, /<option selected>Land I own<\/option>/);

  const bad = await post(sam, `/customers/${customer.id}/credit`, { a_first_name: 'Jordan', ssn: '12345', a_monthly_income: 'lots' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.text, /9 digits/);
  assert.match(bad.text, /Gross monthly income must be a number/);

  const res = await post(sam, `/customers/${customer.id}/credit`, {
    has_co: '1', a_first_name: 'Jordan', a_last_name: 'Rivera', ssn: '123 45 6789', co_ssn: '987654321',
    a_monthly_income: '4,000', c_monthly_income: '1000', a_debt_auto: '400', down_payment: '5000', a_dob: '1985-04-12',
  });
  assert.strictEqual(res.status, 302);
  const row = db.prepare('SELECT * FROM credit_apps').get();
  assert.ok(row.ssn_enc && !row.ssn_enc.includes('6789'), 'SSN is not stored in plain text');
  assert.doesNotMatch(row.data, /6789/);

  const form = await sam.get(`/customers/${customer.id}/credit`);
  assert.match(form.text, /•••-••-6789 on file/);
  assert.doesNotMatch(form.text, /123-45-6789/);

  // Saving again with the SSN box blank keeps the SSN on file.
  await post(sam, `/customers/${customer.id}/credit`, { has_co: '1', a_first_name: 'Jordan', a_monthly_income: '4000' });
  const print = await sam.get(`/customers/${customer.id}/credit/print`);
  assert.match(print.text, /123-45-6789/);
  assert.match(print.text, /Credit Application/);
  const printBlank = await sam.get(`/customers/${customer.id}/credit/print?blank_ssn=1`);
  assert.doesNotMatch(printBlank.text, /123-45-6789/);
  assert.match((await sam.get(`/customers/${customer.id}`)).text, /Printed credit application/);
});

test('customer page shows max budget per lender and in-stock homes that fit', async () => {
  const customer = addCustomer(db);
  addHome(db, { stock_number: 'FITS-1', price: 120000 });
  addHome(db, { stock_number: 'TOO-MUCH', price: 900000 });
  const boss = await as(app, 'boss');
  await post(boss, `/customers/${customer.id}/credit`, { a_first_name: 'Jordan', a_monthly_income: '6000', a_debt_auto: '300', down_payment: '10000' });
  const page = await boss.get(`/customers/${customer.id}`);
  assert.match(page.text, /Max budget \(Triad Financial \(estimate\)\)/);
  assert.match(page.text, /21st Mortgage \(estimate\)/);
  assert.match(page.text, />#FITS-1<\/a>/);
  assert.doesNotMatch(page.text, />#TOO-MUCH<\/a>/);
  assert.match((await boss.get('/customers')).text, /Max budget/);

  // Lender rules are editable by managers only.
  const triad = db.prepare("SELECT * FROM lender_profiles WHERE name LIKE 'Triad%'").get();
  await post(boss, `/settings/lenders/${triad.id}`, { name: 'Triad', dti_max: '45', rate: '8.5', term_months: '300', min_down_percent: '5', active: '1' });
  assert.strictEqual(db.prepare('SELECT dti_max FROM lender_profiles WHERE id = ?').get(triad.id).dti_max, 45);
  const sam = await as(app, 'sam');
  assert.strictEqual((await sam.get('/settings/lenders')).status, 403);
});

test('lender submissions track status and move the customer through the pipeline', async () => {
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  await post(sam, `/customers/${customer.id}/submissions`, { lender: '21st Mortgage', amount_requested: '95000' });
  let c = db.prepare('SELECT lead_status FROM customers').get();
  assert.strictEqual(c.lead_status, 'application');
  const sub = db.prepare('SELECT * FROM lender_submissions').get();
  await post(sam, `/customers/${customer.id}/submissions/${sub.id}`, {
    status: 'approved', amount_approved: '92,500', rate: '8.75', term_months: '240', payment: '818.14', conditions: 'POI, proof of land',
  });
  const updated = db.prepare('SELECT * FROM lender_submissions').get();
  assert.deepStrictEqual([updated.status, updated.amount_approved, updated.rate, updated.term_months], ['approved', 92500, 8.75, 240]);
  c = db.prepare('SELECT lead_status FROM customers').get();
  assert.strictEqual(c.lead_status, 'approved');
  const page = await sam.get(`/customers/${customer.id}`);
  assert.match(page.text, /21st Mortgage: Submitted → Approved/);
});

test('document checklist records what has been received and by whom', async () => {
  const customer = addCustomer(db);
  const sam = await as(app, 'sam');
  await post(sam, `/customers/${customer.id}/documents`, { docs: ['photo_id', 'paystubs'] });
  assert.deepStrictEqual(
    db.prepare('SELECT doc_type, received_by FROM customer_documents ORDER BY doc_type').all(),
    [{ doc_type: 'paystubs', received_by: 2 }, { doc_type: 'photo_id', received_by: 2 }]
  );
  await post(sam, `/customers/${customer.id}/documents`, { docs: 'paystubs' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM customer_documents').get().n, 1);
  const page = await sam.get(`/customers/${customer.id}`);
  assert.match(page.text, /1 of 13/);
  assert.match(page.text, /Documents: received Photo ID \(applicant\), Recent paystubs/);
});
