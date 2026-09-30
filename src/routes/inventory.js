const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireRole } = require('../auth');
const { INVENTORY_STATUSES, HOME_TYPES, getSettings } = require('../db');
const { text, number, date } = require('../format');
const { logActivity } = require('../deals');
const { syncDealCommission } = require('../books');

const managerOnly = requireRole('manager');

const NUMERIC_FIELDS = {
  year: { integer: true, min: 1950, max: 2100, label: 'Year' },
  bedrooms: { integer: true, min: 0, max: 20, label: 'Bedrooms' },
  bathrooms: { min: 0, max: 20, label: 'Bathrooms' },
  square_feet: { integer: true, min: 0, max: 20000, label: 'Square feet' },
  width_ft: { integer: true, min: 0, max: 200, label: 'Width' },
  length_ft: { integer: true, min: 0, max: 200, label: 'Length' },
  price: { min: 0, max: 100000000, label: 'Price' },
  invoice_cost: { min: 0, max: 100000000, label: 'Invoice cost' },
  freight_cost: { min: 0, max: 100000000, label: 'Freight cost' },
  other_cost: { min: 0, max: 100000000, label: 'Other cost' },
};

const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const SORTS = {
  newest: 'i.created_at DESC, i.id DESC',
  oldest: 'COALESCE(i.arrival_date, i.created_at) ASC, i.id ASC',
  price_low: 'i.price IS NULL, i.price ASC',
  price_high: 'i.price DESC',
  stock: 'i.stock_number ASC',
};

function parseHome(body) {
  const values = {
    stock_number: text(body.stock_number, 40),
    manufacturer: text(body.manufacturer, 100),
    model: text(body.model, 100),
    home_type: text(body.home_type, 40),
    serial_number: text(body.serial_number, 60),
    location: text(body.location, 100),
    exterior_color: text(body.exterior_color, 100),
    features: text(body.features, 4000),
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
  const arrival = date(body.arrival_date);
  if (arrival.error) errors.push('Arrival date is invalid.');
  values.arrival_date = arrival.error ? null : arrival.value;
  return { values, errors };
}

module.exports = function inventoryRoutes(db, { uploadDir }) {
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + PHOTO_TYPES[file.mimetype]),
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 20 },
    fileFilter: (req, file, cb) => cb(null, Boolean(PHOTO_TYPES[file.mimetype])),
  });

  const selectHome = db.prepare(`
    SELECT i.*, c.first_name, c.last_name
    FROM inventory i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ?
  `);
  const insertHome = db.prepare(`
    INSERT INTO inventory (stock_number, manufacturer, model, year, home_type, serial_number, bedrooms,
      bathrooms, square_feet, width_ft, length_ft, price, location, notes, exterior_color, features,
      arrival_date, invoice_cost, freight_cost, other_cost, created_by)
    VALUES (@stock_number, @manufacturer, @model, @year, @home_type, @serial_number, @bedrooms,
      @bathrooms, @square_feet, @width_ft, @length_ft, @price, @location, @notes, @exterior_color, @features,
      @arrival_date, @invoice_cost, @freight_cost, @other_cost, @created_by)
  `);
  const updateHome = db.prepare(`
    UPDATE inventory SET stock_number = @stock_number, manufacturer = @manufacturer, model = @model,
      year = @year, home_type = @home_type, serial_number = @serial_number, bedrooms = @bedrooms,
      bathrooms = @bathrooms, square_feet = @square_feet, width_ft = @width_ft, length_ft = @length_ft,
      price = @price, location = @location, notes = @notes, exterior_color = @exterior_color,
      features = @features, arrival_date = @arrival_date, invoice_cost = @invoice_cost,
      freight_cost = @freight_cost, other_cost = @other_cost, updated_at = datetime('now')
    WHERE id = @id
  `);
  const stockTaken = db.prepare('SELECT id FROM inventory WHERE stock_number = ? AND id != ?');
  const hasDeals = db.prepare('SELECT 1 FROM deals WHERE inventory_id = ? LIMIT 1');
  const deleteHome = db.prepare('DELETE FROM inventory WHERE id = ? AND customer_id IS NULL');
  // Guarded so two associates can't grab the same home at once.
  const claimHome = db.prepare(`
    UPDATE inventory SET customer_id = ?, assigned_by = ?, assigned_at = datetime('now'),
      status = 'pending', updated_at = datetime('now')
    WHERE id = ? AND status = 'available' AND customer_id IS NULL
  `);
  const insertDeal = db.prepare(`
    INSERT INTO deals (customer_id, inventory_id, salesperson_id, sale_price, tax_rate, doc_fee, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findCustomer = db.prepare('SELECT id, first_name, last_name, salesperson_id, lead_status FROM customers WHERE id = ?');
  const setLeadStatus = db.prepare("UPDATE customers SET lead_status = ?, updated_at = datetime('now') WHERE id = ?");
  const allCustomers = db.prepare(
    "SELECT id, first_name, last_name, phone FROM customers WHERE lead_status != 'lost' ORDER BY last_name, first_name"
  );
  const photosFor = db.prepare('SELECT * FROM photos WHERE inventory_id = ? ORDER BY id');
  const insertPhoto = db.prepare(
    'INSERT INTO photos (inventory_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?)'
  );
  const selectPhoto = db.prepare('SELECT * FROM photos WHERE id = ? AND inventory_id = ?');
  const deletePhoto = db.prepare('DELETE FROM photos WHERE id = ?');
  const dealsFor = db.prepare(`
    SELECT d.*, c.first_name, c.last_name, u.full_name AS salesperson_name FROM deals d
    JOIN customers c ON c.id = d.customer_id LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.inventory_id = ? ORDER BY d.created_at DESC, d.id DESC
  `);
  const notesFor = db.prepare(`
    SELECT n.*, u.full_name AS author FROM notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.inventory_id = ? ORDER BY n.created_at DESC, n.id DESC
  `);
  const activityFor = db.prepare(`
    SELECT a.*, u.full_name AS author FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.inventory_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 50
  `);

  function loadHome(req, res, next) {
    const home = selectHome.get(Number(req.params.id));
    if (!home) {
      return res.status(404).render('error', { title: 'Not found', message: 'That inventory item does not exist.' });
    }
    req.home = home;
    next();
  }

  // Sales associates never see what a home cost the dealership.
  function stripCosts(home, user) {
    if (user.role === 'manager') return home;
    const { invoice_cost, freight_cost, other_cost, ...rest } = home; // eslint-disable-line no-unused-vars
    return rest;
  }

  router.get('/', (req, res) => {
    const status = INVENTORY_STATUSES.includes(req.query.status) || req.query.status === 'all'
      ? req.query.status
      : 'available';
    const q = text(req.query.q, 100);
    const type = HOME_TYPES.includes(req.query.type) ? req.query.type : '';
    const beds = number(req.query.beds, { integer: true, max: 20 }).value;
    const maxPrice = number(req.query.max_price, { max: 100000000 }).value;
    const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';

    const where = [];
    const params = {};
    if (status !== 'all') {
      where.push('i.status = @status');
      params.status = status;
    }
    if (q) {
      where.push(`(i.stock_number LIKE @q OR i.manufacturer LIKE @q OR i.model LIKE @q
        OR i.serial_number LIKE @q OR i.home_type LIKE @q OR i.features LIKE @q OR i.location LIKE @q)`);
      params.q = `%${q}%`;
    }
    if (type) {
      where.push('i.home_type = @type');
      params.type = type;
    }
    if (beds) {
      where.push('i.bedrooms >= @beds');
      params.beds = beds;
    }
    if (maxPrice) {
      where.push('i.price <= @maxPrice');
      params.maxPrice = maxPrice;
    }
    const homes = db
      .prepare(`
        SELECT i.*, c.first_name, c.last_name,
          (SELECT id FROM photos p WHERE p.inventory_id = i.id ORDER BY p.id LIMIT 1) AS photo_id
        FROM inventory i
        LEFT JOIN customers c ON c.id = i.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${SORTS[sort]}
      `)
      .all(params);
    const totalValue = homes.reduce((sum, h) => sum + (h.price || 0), 0);
    res.render('inventory/index', {
      title: 'Inventory',
      homes,
      totalValue,
      status,
      filters: { q: q || '', type, beds: beds || '', max_price: maxPrice || '', sort },
    });
  });

  // Both roles: assign an available home to an existing customer, which opens a
  // pending deal priced at the home's list price.
  router.post('/assign', (req, res) => {
    const home = selectHome.get(Number(req.body.inventory_id));
    const customer = findCustomer.get(Number(req.body.customer_id));
    const back = req.body.from === 'customer' && customer ? `/customers/${customer.id}` : home ? `/inventory/${home.id}` : '/inventory';

    if (!home) {
      req.flash('error', 'Choose an available home to assign.');
      return res.redirect(back);
    }
    if (!customer) {
      req.flash('error', 'Choose an existing customer to assign this home to.');
      return res.redirect(back);
    }

    const settings = getSettings(db);
    const dealId = db.transaction(() => {
      if (claimHome.run(customer.id, req.user.id, home.id).changes === 0) return null;
      const info = insertDeal.run(
        customer.id,
        home.id,
        customer.salesperson_id || req.user.id,
        home.price || 0,
        Number(settings.default_tax_rate) || 0,
        Number(settings.default_doc_fee) || 0,
        req.user.id
      );
      if (!['closed'].includes(customer.lead_status)) setLeadStatus.run('under_contract', customer.id);
      logActivity(db, {
        userId: req.user.id,
        customerId: customer.id,
        inventoryId: home.id,
        dealId: info.lastInsertRowid,
        message: `Assigned stock #${home.stock_number} to ${customer.first_name} ${customer.last_name} (deal opened)`,
      });
      return info.lastInsertRowid;
    })();

    if (!dealId) {
      req.flash('error', `Stock #${home.stock_number} is no longer available.`);
      return res.redirect(back);
    }
    req.flash('success', `Stock #${home.stock_number} assigned to ${customer.first_name} ${customer.last_name}. Set the pricing and take a deposit below.`);
    res.redirect(`/deals/${dealId}`);
  });

  router.get('/new', managerOnly, (req, res) => {
    res.render('inventory/form', { title: 'Add inventory', home: {}, errors: [] });
  });

  router.post('/', managerOnly, (req, res) => {
    const { values, errors } = parseHome(req.body);
    if (!errors.length && stockTaken.get(values.stock_number, 0)) errors.push('That stock number is already in use.');
    if (errors.length) {
      return res.status(400).render('inventory/form', { title: 'Add inventory', home: values, errors });
    }
    const info = insertHome.run({ ...values, created_by: req.user.id });
    logActivity(db, { userId: req.user.id, inventoryId: info.lastInsertRowid, message: `Added stock #${values.stock_number} to inventory` });
    req.flash('success', `Stock #${values.stock_number} added to inventory. Add photos below.`);
    res.redirect(`/inventory/${info.lastInsertRowid}`);
  });

  router.get('/:id', loadHome, (req, res) => {
    const deals = dealsFor.all(req.home.id);
    res.render('inventory/show', {
      title: `Stock #${req.home.stock_number}`,
      home: stripCosts(req.home, req.user),
      customers: req.home.status === 'available' ? allCustomers.all() : [],
      photos: photosFor.all(req.home.id),
      activeDeal: deals.find((d) => d.status !== 'cancelled') || null,
      deals,
      notes: notesFor.all(req.home.id),
      activity: activityFor.all(req.home.id),
    });
  });

  router.get('/:id/edit', managerOnly, loadHome, (req, res) => {
    res.render('inventory/form', { title: 'Edit inventory', home: req.home, errors: [] });
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
      });
    }
    updateHome.run({ ...values, id: req.home.id });
    // Dealer cost feeds gross profit, so sold deals on this home need their commission rechecked.
    for (const d of db.prepare("SELECT id FROM deals WHERE inventory_id = ? AND status = 'sold'").all(req.home.id)) {
      syncDealCommission(db, d.id, req.user.id);
    }
    if (req.home.price !== values.price) {
      logActivity(db, {
        userId: req.user.id,
        inventoryId: req.home.id,
        message: `Changed list price of stock #${values.stock_number} from ${req.home.price ?? 'none'} to ${values.price ?? 'none'}`,
      });
    }
    req.flash('success', 'Inventory item updated.');
    res.redirect(`/inventory/${req.home.id}`);
  });

  router.post('/:id/delete', managerOnly, loadHome, (req, res) => {
    if (req.home.customer_id || hasDeals.get(req.home.id)) {
      req.flash('error', 'This home has deal history, so it can’t be deleted. Keep it for your records.');
      return res.redirect(`/inventory/${req.home.id}`);
    }
    const photos = photosFor.all(req.home.id);
    if (deleteHome.run(req.home.id).changes === 0) {
      req.flash('error', 'This home could not be deleted.');
      return res.redirect(`/inventory/${req.home.id}`);
    }
    for (const p of photos) fs.rm(path.join(uploadDir, p.filename), { force: true }, () => {});
    logActivity(db, { userId: req.user.id, message: `Deleted stock #${req.home.stock_number} from inventory` });
    req.flash('success', `Stock #${req.home.stock_number} deleted.`);
    res.redirect('/inventory');
  });

  router.post('/:id/photos', managerOnly, loadHome, (req, res, next) => {
    upload.array('photos', 20)(req, res, (err) => {
      if (err) {
        req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Photos must be under 15 MB each.' : 'Photo upload failed.');
        return res.redirect(`/inventory/${req.home.id}`);
      }
      next();
    });
  }, (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      req.flash('error', 'Choose one or more JPG, PNG, WebP or GIF photos to upload.');
      return res.redirect(`/inventory/${req.home.id}`);
    }
    for (const f of files) insertPhoto.run(req.home.id, f.filename, text(f.originalname, 200), f.mimetype, req.user.id);
    req.flash('success', `${files.length} photo${files.length === 1 ? '' : 's'} added.`);
    res.redirect(`/inventory/${req.home.id}#photos`);
  });

  router.post('/:id/photos/:photoId/delete', managerOnly, loadHome, (req, res) => {
    const photo = selectPhoto.get(Number(req.params.photoId), req.home.id);
    if (photo) {
      deletePhoto.run(photo.id);
      fs.rm(path.join(uploadDir, photo.filename), { force: true }, () => {});
      req.flash('success', 'Photo removed.');
    }
    res.redirect(`/inventory/${req.home.id}#photos`);
  });

  return router;
};
