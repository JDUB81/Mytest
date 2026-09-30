const express = require('express');
const { text } = require('../format');

module.exports = function searchRoutes(db) {
  const router = express.Router();

  const findCustomers = db.prepare(`
    SELECT id, first_name, last_name, phone, email, lead_status FROM customers
    WHERE first_name LIKE @q OR last_name LIKE @q OR (first_name || ' ' || last_name) LIKE @q
       OR phone LIKE @q OR email LIKE @q OR co_buyer_name LIKE @q
       OR REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @digits
    ORDER BY last_name, first_name LIMIT 25
  `);
  const findHomes = db.prepare(`
    SELECT id, stock_number, manufacturer, model, year, status, price FROM inventory
    WHERE stock_number LIKE @q OR manufacturer LIKE @q OR model LIKE @q OR serial_number LIKE @q
    ORDER BY stock_number LIMIT 25
  `);
  const findDeals = db.prepare(`
    SELECT d.id, d.status, c.first_name, c.last_name, i.stock_number FROM deals d
    JOIN customers c ON c.id = d.customer_id JOIN inventory i ON i.id = d.inventory_id
    WHERE CAST(d.id AS TEXT) = @exact OR i.stock_number LIKE @q OR d.lender LIKE @q
    ORDER BY d.id DESC LIMIT 25
  `);

  router.get('/search', (req, res) => {
    const q = text(req.query.q, 100);
    let results = { customers: [], homes: [], deals: [] };
    if (q) {
      const digits = q.replace(/\D/g, '');
      const params = { q: `%${q}%`, exact: q.replace(/^#/, ''), digits: digits.length >= 3 ? `%${digits}%` : '\u0000' };
      results = { customers: findCustomers.all(params), homes: findHomes.all(params), deals: findDeals.all(params) };
      const total = results.customers.length + results.homes.length + results.deals.length;
      if (total === 1) {
        if (results.customers.length) return res.redirect(`/customers/${results.customers[0].id}`);
        if (results.homes.length) return res.redirect(`/inventory/${results.homes[0].id}`);
        return res.redirect(`/deals/${results.deals[0].id}`);
      }
    }
    res.render('search', { title: 'Search', q: q || '', results });
  });

  return router;
};
