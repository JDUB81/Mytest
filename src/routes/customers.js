const express = require('express');
const { requireRole } = require('../auth');
const { text } = require('../format');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCustomer(body) {
  const values = {
    first_name: text(body.first_name, 60),
    last_name: text(body.last_name, 60),
    phone: text(body.phone, 30),
    email: text(body.email, 120),
    address: text(body.address, 200),
    city: text(body.city, 80),
    state: text(body.state, 40),
    zip: text(body.zip, 15),
    notes: text(body.notes, 4000),
  };
  const errors = [];
  if (!values.first_name) errors.push('First name is required.');
  if (!values.last_name) errors.push('Last name is required.');
  if (!values.phone && !values.email) errors.push('Enter a phone number or email so we can reach the customer.');
  if (values.email && !EMAIL_RE.test(values.email)) errors.push('Email address looks invalid.');
  return { values, errors };
}

module.exports = function customerRoutes(db) {
  const router = express.Router();

  const selectCustomer = db.prepare(`
    SELECT c.*, u.full_name AS created_by_name FROM customers c
    LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?
  `);
  const insertCustomer = db.prepare(`
    INSERT INTO customers (first_name, last_name, phone, email, address, city, state, zip, notes, created_by)
    VALUES (@first_name, @last_name, @phone, @email, @address, @city, @state, @zip, @notes, @created_by)
  `);
  const updateCustomer = db.prepare(`
    UPDATE customers SET first_name = @first_name, last_name = @last_name, phone = @phone, email = @email,
      address = @address, city = @city, state = @state, zip = @zip, notes = @notes, updated_at = datetime('now')
    WHERE id = @id
  `);
  const deleteCustomer = db.prepare(
    'DELETE FROM customers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM inventory WHERE customer_id = customers.id)'
  );
  const homesForCustomer = db.prepare('SELECT * FROM inventory WHERE customer_id = ? ORDER BY assigned_at DESC');
  const availableHomes = db.prepare(
    "SELECT id, stock_number, manufacturer, model, year, price FROM inventory WHERE status = 'available' ORDER BY stock_number"
  );

  function loadCustomer(req, res, next) {
    const customer = selectCustomer.get(Number(req.params.id));
    if (!customer) {
      return res.status(404).render('error', { title: 'Not found', message: 'That customer does not exist.' });
    }
    req.customer = customer;
    next();
  }

  router.get('/', (req, res) => {
    const q = text(req.query.q, 100);
    const sql = `
      SELECT c.*, (SELECT COUNT(*) FROM inventory i WHERE i.customer_id = c.id) AS home_count
      FROM customers c
      ${q ? `WHERE c.first_name LIKE @q OR c.last_name LIKE @q OR (c.first_name || ' ' || c.last_name) LIKE @q
             OR c.phone LIKE @q OR c.email LIKE @q` : ''}
      ORDER BY c.last_name, c.first_name
    `;
    const customers = db.prepare(sql).all(q ? { q: `%${q}%` } : {});
    res.render('customers/index', { title: 'Customers', customers, q: q || '' });
  });

  router.get('/new', (req, res) => {
    res.render('customers/form', { title: 'New customer', customer: {}, errors: [] });
  });

  router.post('/', (req, res) => {
    const { values, errors } = parseCustomer(req.body);
    if (errors.length) {
      return res.status(400).render('customers/form', { title: 'New customer', customer: values, errors });
    }
    const info = insertCustomer.run({ ...values, created_by: req.user.id });
    req.session.flash = { type: 'success', message: `${values.first_name} ${values.last_name} added.` };
    res.redirect(`/customers/${info.lastInsertRowid}`);
  });

  router.get('/:id', loadCustomer, (req, res) => {
    res.render('customers/show', {
      title: `${req.customer.first_name} ${req.customer.last_name}`,
      customer: req.customer,
      homes: homesForCustomer.all(req.customer.id),
      availableHomes: availableHomes.all(),
    });
  });

  router.get('/:id/edit', loadCustomer, (req, res) => {
    res.render('customers/form', { title: 'Edit customer', customer: req.customer, errors: [] });
  });

  router.post('/:id', loadCustomer, (req, res) => {
    const { values, errors } = parseCustomer(req.body);
    if (errors.length) {
      return res.status(400).render('customers/form', {
        title: 'Edit customer',
        customer: { ...values, id: req.customer.id },
        errors,
      });
    }
    updateCustomer.run({ ...values, id: req.customer.id });
    req.session.flash = { type: 'success', message: 'Customer updated.' };
    res.redirect(`/customers/${req.customer.id}`);
  });

  router.post('/:id/delete', requireRole('manager'), loadCustomer, (req, res) => {
    if (deleteCustomer.run(req.customer.id).changes === 0) {
      req.session.flash = { type: 'error', message: 'Release this customer’s homes before deleting them.' };
      return res.redirect(`/customers/${req.customer.id}`);
    }
    req.session.flash = { type: 'success', message: 'Customer deleted.' };
    res.redirect('/customers');
  });

  return router;
};
