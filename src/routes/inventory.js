const express = require('express');
const { requireRole } = require('../auth');
const { INVENTORY_STATUSES, HOME_TYPES } = require('../db');
const { text, number } = require('../format');

const managerOnly = requireRole('manager');

const NUMERIC_FIELDS = {
  year: { integer: true, min: 1950, max: 2100, label: 'Year' },
  bedrooms: { integer: true, min: 0, max: 20, label: 'Bedrooms' },
  bathrooms: { min: 0, max: 20, label: 'Bathrooms' },
  square_feet: { integer: true, min: 0, max: 20000, label: 'Square feet' },
  width_ft: { integer: true, min: 0, max: 200, label: 'Width' },
  length_ft: { integer: true, min: 0, max: 200, label: 'Length' },
  price: { min: 0, max: 100000000, label: 'Price' },
};

function parseHome(body) {
  const values = {
    stock_number: text(body.stock_number, 40),
    manufacturer: text(body.manufacturer, 100),
    model: text(body.model, 100),
    home_type: text(body.home_type, 40),
    serial_number: text(body.serial_number, 60),
    location: text(body.location, 100),
    notes: text(body.notes, 2000),
  };
  const errors = [];
  if (!values.stock_number) errors.push('Stock number is required.');
  if (!values.manufacturer) errors.push('Manufacturer is required.');
  if (!values.model) errors.push('Model is required.');
  if (!HOME_TYPES.includes(values.home_type)) errors.push('Choose a home type.');

  for (const [field, opts] of Object.entries(NUMERIC_FIELDS)) {
    const parsed = number(body[field], opts);
    if (parsed.error) {
      errors.push(`${opts.label} must be a valid number.`);
      values[field] = body[field];
    } else {
      values[field] = parsed.value;
    }
  }
  return { values, errors };
}

module.exports = function inventoryRoutes(db) {
  const router = express.Router();

  const selectHome = db.prepare(`
    SELECT i.*, c.first_name, c.last_name, u.full_name AS assigned_by_name
    FROM inventory i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN users u ON u.id = i.assigned_by
    WHERE i.id = ?
  `);
  const insertHome = db.prepare(`
    INSERT INTO inventory (stock_number, manufacturer, model, year, home_type, serial_number, bedrooms,
      bathrooms, square_feet, width_ft, length_ft, price, location, notes, created_by)
    VALUES (@stock_number, @manufacturer, @model, @year, @home_type, @serial_number, @bedrooms,
      @bathrooms, @square_feet, @width_ft, @length_ft, @price, @location, @notes, @created_by)
  `);
  const updateHome = db.prepare(`
    UPDATE inventory SET stock_number = @stock_number, manufacturer = @manufacturer, model = @model,
      year = @year, home_type = @home_type, serial_number = @serial_number, bedrooms = @bedrooms,
      bathrooms = @bathrooms, square_feet = @square_feet, width_ft = @width_ft, length_ft = @length_ft,
      price = @price, location = @location, notes = @notes, updated_at = datetime('now')
    WHERE id = @id
  `);
  const stockTaken = db.prepare('SELECT id FROM inventory WHERE stock_number = ? AND id != ?');
  const deleteHome = db.prepare('DELETE FROM inventory WHERE id = ? AND customer_id IS NULL');
  // Guarded so two associates can't grab the same home at once.
  const assignHome = db.prepare(`
    UPDATE inventory SET customer_id = ?, assigned_by = ?, assigned_at = datetime('now'),
      status = 'pending', updated_at = datetime('now')
    WHERE id = ? AND status = 'available' AND customer_id IS NULL
  `);
  const releaseHome = db.prepare(`
    UPDATE inventory SET customer_id = NULL, assigned_by = NULL, assigned_at = NULL,
      status = 'available', updated_at = datetime('now')
    WHERE id = ?
  `);
  const markSold = db.prepare(`
    UPDATE inventory SET status = 'sold', updated_at = datetime('now')
    WHERE id = ? AND status = 'pending' AND customer_id IS NOT NULL
  `);
  const customerExists = db.prepare('SELECT id, first_name, last_name FROM customers WHERE id = ?');
  const allCustomers = db.prepare('SELECT id, first_name, last_name, phone FROM customers ORDER BY last_name, first_name');

  function flash(req, type, message) {
    req.session.flash = { type, message };
  }

  function loadHome(req, res, next) {
    const home = selectHome.get(Number(req.params.id));
    if (!home) {
      return res.status(404).render('error', { title: 'Not found', message: 'That inventory item does not exist.' });
    }
    req.home = home;
    next();
  }

  router.get('/', (req, res) => {
    const status = INVENTORY_STATUSES.includes(req.query.status) || req.query.status === 'all'
      ? req.query.status
      : 'available';
    const q = text(req.query.q, 100);
    const where = [];
    const params = {};
    if (status !== 'all') {
      where.push('i.status = @status');
      params.status = status;
    }
    if (q) {
      where.push(`(i.stock_number LIKE @q OR i.manufacturer LIKE @q OR i.model LIKE @q
        OR i.serial_number LIKE @q OR i.home_type LIKE @q)`);
      params.q = `%${q}%`;
    }
    const homes = db
      .prepare(`
        SELECT i.*, c.first_name, c.last_name FROM inventory i
        LEFT JOIN customers c ON c.id = i.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY i.created_at DESC, i.id DESC
      `)
      .all(params);
    res.render('inventory/index', { title: 'Inventory', homes, status, q: q || '' });
  });

  // Both roles: assign an available home to an existing customer. Posted from
  // either the home's page or the customer's page; we return to whichever it was.
  router.post('/assign', (req, res) => {
    const home = selectHome.get(Number(req.body.inventory_id));
    const customer = customerExists.get(Number(req.body.customer_id));
    const back = req.body.from === 'customer' && customer ? `/customers/${customer.id}` : home ? `/inventory/${home.id}` : '/inventory';

    if (!home) {
      flash(req, 'error', 'Choose an available home to assign.');
    } else if (!customer) {
      flash(req, 'error', 'Choose an existing customer to assign this home to.');
    } else if (assignHome.run(customer.id, req.user.id, home.id).changes === 0) {
      flash(req, 'error', `Stock #${home.stock_number} is no longer available.`);
    } else {
      flash(req, 'success', `Stock #${home.stock_number} assigned to ${customer.first_name} ${customer.last_name}.`);
    }
    res.redirect(back);
  });

  router.get('/new', managerOnly, (req, res) => {
    res.render('inventory/form', { title: 'Add inventory', home: {}, errors: [], HOME_TYPES });
  });

  router.post('/', managerOnly, (req, res) => {
    const { values, errors } = parseHome(req.body);
    if (!errors.length && stockTaken.get(values.stock_number, 0)) errors.push('That stock number is already in use.');
    if (errors.length) {
      return res.status(400).render('inventory/form', { title: 'Add inventory', home: values, errors, HOME_TYPES });
    }
    const info = insertHome.run({ ...values, created_by: req.user.id });
    flash(req, 'success', `Stock #${values.stock_number} added to inventory.`);
    res.redirect(`/inventory/${info.lastInsertRowid}`);
  });

  router.get('/:id', loadHome, (req, res) => {
    res.render('inventory/show', {
      title: `Stock #${req.home.stock_number}`,
      home: req.home,
      customers: req.home.status === 'available' ? allCustomers.all() : [],
    });
  });

  router.get('/:id/edit', managerOnly, loadHome, (req, res) => {
    res.render('inventory/form', { title: 'Edit inventory', home: req.home, errors: [], HOME_TYPES });
  });

  router.post('/:id', managerOnly, loadHome, (req, res) => {
    const { values, errors } = parseHome(req.body);
    if (!errors.length && stockTaken.get(values.stock_number, req.home.id)) {
      errors.push('That stock number is already in use.');
    }
    if (errors.length) {
      return res.status(400).render('inventory/form', {
        title: 'Edit inventory',
        home: { ...values, id: req.home.id },
        errors,
        HOME_TYPES,
      });
    }
    updateHome.run({ ...values, id: req.home.id });
    flash(req, 'success', 'Inventory item updated.');
    res.redirect(`/inventory/${req.home.id}`);
  });

  router.post('/:id/delete', managerOnly, loadHome, (req, res) => {
    if (deleteHome.run(req.home.id).changes === 0) {
      flash(req, 'error', 'Release this home from its customer before deleting it.');
      return res.redirect(`/inventory/${req.home.id}`);
    }
    flash(req, 'success', `Stock #${req.home.stock_number} deleted.`);
    res.redirect('/inventory');
  });

  router.post('/:id/release', managerOnly, loadHome, (req, res) => {
    releaseHome.run(req.home.id);
    flash(req, 'success', `Stock #${req.home.stock_number} is available again.`);
    res.redirect(`/inventory/${req.home.id}`);
  });

  router.post('/:id/sold', managerOnly, loadHome, (req, res) => {
    if (markSold.run(req.home.id).changes === 0) {
      flash(req, 'error', 'Only a pending home assigned to a customer can be marked sold.');
    } else {
      flash(req, 'success', `Stock #${req.home.stock_number} marked as sold.`);
    }
    res.redirect(`/inventory/${req.home.id}`);
  });

  return router;
};
