const express = require('express');
const { requireRole } = require('../auth');
const { getSettings, DEFAULT_SETTINGS } = require('../db');
const { text, number } = require('../format');
const { logActivity } = require('../deals');

const NUMERIC = {
  default_tax_rate: { max: 30, label: 'Default tax rate' },
  default_doc_fee: { max: 100000, label: 'Default doc fee' },
  commission_percent: { max: 100, label: 'Commission percent' },
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

  return router;
};
