const express = require('express');

module.exports = function dashboardRoutes(db) {
  const router = express.Router();

  const statusCounts = db.prepare('SELECT status, COUNT(*) AS n FROM inventory GROUP BY status');
  const customerCount = db.prepare('SELECT COUNT(*) AS n FROM customers');
  const recentAssignments = db.prepare(`
    SELECT i.id, i.stock_number, i.manufacturer, i.model, i.status, i.assigned_at,
           c.id AS customer_id, c.first_name, c.last_name
    FROM inventory i JOIN customers c ON c.id = i.customer_id
    ORDER BY i.assigned_at DESC LIMIT 5
  `);
  const recentCustomers = db.prepare(
    'SELECT id, first_name, last_name, phone, created_at FROM customers ORDER BY created_at DESC, id DESC LIMIT 5'
  );

  router.get('/', (req, res) => {
    const counts = { available: 0, pending: 0, sold: 0 };
    for (const row of statusCounts.all()) counts[row.status] = row.n;
    res.render('dashboard', {
      title: 'Dashboard',
      counts,
      customers: customerCount.get().n,
      assignments: recentAssignments.all(),
      recentCustomers: recentCustomers.all(),
    });
  });

  return router;
};
