const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { requireRole } = require('../auth');
const { getSettings, DEFAULT_SETTINGS } = require('../db');
const { text, number } = require('../format');
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

  const catalog = db.prepare('SELECT * FROM addon_catalog ORDER BY active DESC, name');

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
      },
      error: !text(body.name, 200) ? 'Enter a name.' : price.error || cost.error ? 'Price and cost must be numbers.' : null,
    };
  }

  router.get('/addons', (req, res) => {
    res.render('addons', { title: 'Add-on price list', addons: catalog.all() });
  });

  router.post('/addons', (req, res) => {
    const { values, error } = parseAddon(req.body);
    if (error) {
      req.flash('error', error);
      return res.redirect('/settings/addons');
    }
    db.prepare('INSERT INTO addon_catalog (name, price, cost, taxable, active) VALUES (@name, @price, @cost, @taxable, @active)').run(values);
    req.flash('success', `${values.name} added to the price list.`);
    res.redirect('/settings/addons');
  });

  router.post('/addons/:id', (req, res) => {
    const { values, error } = parseAddon(req.body);
    if (error) {
      req.flash('error', error);
      return res.redirect('/settings/addons');
    }
    db.prepare('UPDATE addon_catalog SET name = @name, price = @price, cost = @cost, taxable = @taxable, active = @active WHERE id = @id')
      .run({ ...values, id: Number(req.params.id) });
    req.flash('success', `${values.name} updated. Deals already written keep their own prices.`);
    res.redirect('/settings/addons');
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
