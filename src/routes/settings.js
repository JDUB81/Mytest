const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { requireRole } = require('../auth');
const { getSettings, DEFAULT_SETTINGS, JOB_CATEGORIES } = require('../db');
const { text, number, choice } = require('../format');
const { logActivity, today } = require('../deals');

const NUMERIC = {
  default_tax_rate: { max: 30, label: 'Default tax rate' },
  default_doc_fee: { max: 100000, label: 'Default doc fee' },
  sales_commission_percent: { max: 100, label: 'Salesperson commission' },
  gm_commission_percent: { max: 100, label: 'General manager commission' },
  next_check_number: { integer: true, max: 99999999, label: 'Next check number' },
};

module.exports = function settingsRoutes(db) {
  const router = express.Router();
  router.use(requireRole('manager'));

  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  router.get('/', (req, res) => {
    res.render('settings', { title: 'Settings', values: getSettings(db), errors: [] });
  });

  router.post('/', (req, res) => {
    const values = {};
    const errors = [];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (NUMERIC[key]) {
        const parsed = number(req.body[key], NUMERIC[key]);
        if (parsed.error) errors.push(`${NUMERIC[key].label} must be a number between 0 and ${NUMERIC[key].max}.`);
        values[key] = parsed.error ? req.body[key] : String(parsed.value ?? 0);
      } else {
        values[key] = text(req.body[key], 2000) || '';
      }
    }
    if (!values.business_name) errors.push('Business name is required.');
    if (errors.length) return res.status(400).render('settings', { title: 'Settings', values, errors });

    db.transaction(() => {
      for (const [key, value] of Object.entries(values)) upsert.run(key, value);
      logActivity(db, { userId: req.user.id, message: 'Updated business settings' });
    })();
    req.flash('success', 'Settings saved.');
    res.redirect('/settings');
  });

  // --- Add-on price list ---------------------------------------------------------

  const catalog = db.prepare(`
    SELECT a.*, v.name AS vendor_name,
      (SELECT COUNT(*) FROM deal_items di WHERE di.catalog_id = a.id) AS times_used
    FROM addon_catalog a LEFT JOIN vendors v ON v.id = a.vendor_id
    ORDER BY a.active DESC, a.name
  `);
  const vendorExists = db.prepare('SELECT id FROM vendors WHERE id = ?');

  function parseAddon(body) {
    const price = number(body.price, { max: 100000000 });
    const cost = number(body.cost, { max: 100000000 });
    return {
      values: {
        name: text(body.name, 200),
        price: price.value ?? 0,
        cost: cost.value ?? 0,
        taxable: body.taxable === '1' ? 1 : 0,
        active: body.active === '0' ? 0 : 1,
        category: choice(body.category, JOB_CATEGORIES) || 'Other',
        vendor_id: vendorExists.get(Number(body.vendor_id)) ? Number(body.vendor_id) : null,
      },
      error: !text(body.name, 200) ? 'Enter a name.' : price.error || cost.error ? 'Price and cost must be numbers.' : null,
    };
  }

  router.get('/addons', (req, res) => {
    res.render('addons', {
      title: 'Jobs & add-ons',
      addons: catalog.all(),
      vendors: db.prepare('SELECT id, name, trade FROM vendors WHERE active = 1 ORDER BY name').all(),
    });
  });

  router.post('/addons', (req, res) => {
    const { values, error } = parseAddon(req.body);
    if (error) {
      req.flash('error', error);
      return res.redirect('/settings/addons');
    }
    db.prepare(
      'INSERT INTO addon_catalog (name, price, cost, taxable, active, category, vendor_id) VALUES (@name, @price, @cost, @taxable, @active, @category, @vendor_id)'
    ).run(values);
    req.flash('success', `${values.name} added to the jobs list.`);
    res.redirect('/settings/addons');
  });

  router.post('/addons/:id', (req, res) => {
    const { values, error } = parseAddon(req.body);
    if (error) {
      req.flash('error', error);
      return res.redirect('/settings/addons');
    }
    db.prepare(`
      UPDATE addon_catalog SET name = @name, price = @price, cost = @cost, taxable = @taxable, active = @active,
        category = @category, vendor_id = @vendor_id
      WHERE id = @id
    `)
      .run({ ...values, id: Number(req.params.id) });
    req.flash('success', `${values.name} updated. Deals already written keep their own prices.`);
    res.redirect('/settings/addons');
  });

  // --- Lender rules used for max-budget estimates ------------------------------------

  const lenders = db.prepare('SELECT * FROM lender_profiles ORDER BY active DESC, sort, name');

  function parseLender(body) {
    const errors = [];
    const n = (k, label, opts) => {
      const p = number(body[k], opts);
      if (p.error) errors.push(`${label} is not valid.`);
      return p.value;
    };
    const values = {
      name: text(body.name, 120),
      dti_max: n('dti_max', 'Max DTI', { max: 100 }),
      pti_max: n('pti_max', 'Max PTI', { max: 100 }),
      rate: n('rate', 'Rate', { max: 40 }),
      term_months: n('term_months', 'Term', { integer: true, min: 12, max: 480 }),
      min_down_percent: n('min_down_percent', 'Minimum down', { max: 100 }) ?? 0,
      notes: text(body.notes, 1000),
      active: body.active === '0' ? 0 : 1,
      sort: Number(body.sort) || 0,
    };
    if (!values.name) errors.push('Name is required.');
    if (!values.dti_max) errors.push('Max DTI is required.');
    if (values.rate === null || values.rate === undefined) errors.push('Rate is required.');
    if (!values.term_months) errors.push('Term is required.');
    return { values, errors };
  }

  router.get('/lenders', (req, res) => {
    res.render('lenders', { title: 'Lender rules', lenders: lenders.all(), insurance: getSettings(db).budget_insurance_monthly });
  });

  router.post('/lenders', (req, res) => {
    const { values, errors } = parseLender(req.body);
    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect('/settings/lenders');
    }
    db.prepare(`
      INSERT INTO lender_profiles (name, dti_max, pti_max, rate, term_months, min_down_percent, notes, active, sort)
      VALUES (@name, @dti_max, @pti_max, @rate, @term_months, @min_down_percent, @notes, @active, @sort)
    `).run(values);
    req.flash('success', `${values.name} added.`);
    res.redirect('/settings/lenders');
  });

  router.post('/lenders/insurance', (req, res) => {
    const p = number(req.body.budget_insurance_monthly, { max: 10000 });
    if (p.error) req.flash('error', 'Insurance estimate must be a number.');
    else {
      upsert.run('budget_insurance_monthly', String(p.value ?? 0));
      req.flash('success', 'Insurance estimate saved.');
    }
    res.redirect('/settings/lenders');
  });

  router.post('/lenders/:id', (req, res) => {
    const { values, errors } = parseLender(req.body);
    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect('/settings/lenders');
    }
    db.prepare(`
      UPDATE lender_profiles SET name = @name, dti_max = @dti_max, pti_max = @pti_max, rate = @rate, term_months = @term_months,
        min_down_percent = @min_down_percent, notes = @notes, active = @active, sort = @sort
      WHERE id = @id
    `).run({ ...values, id: Number(req.params.id) });
    logActivity(db, { userId: req.user.id, message: `Updated lender rules for ${values.name}` });
    req.flash('success', `${values.name} updated.`);
    res.redirect('/settings/lenders');
  });

  // Consistent snapshot of the whole database (safe while the app is running).
  router.get('/backup', async (req, res, next) => {
    const file = path.join(os.tmpdir(), `premier-backup-${process.pid}-${Date.now()}.db`);
    try {
      await db.backup(file);
      logActivity(db, { userId: req.user.id, message: 'Downloaded a database backup' });
      res.download(file, `premier-homes-backup-${today()}.db`, () => fs.rm(file, { force: true }, () => {}));
    } catch (err) {
      fs.rm(file, { force: true }, () => {});
      next(err);
    }
  });

  return router;
};
