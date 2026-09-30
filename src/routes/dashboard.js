const express = require('express');
const { dealTotals, round2, today } = require('../deals');

module.exports = function dashboardRoutes(db) {
  const router = express.Router();

  const statusCounts = db.prepare('SELECT status, COUNT(*) AS n FROM inventory GROUP BY status');
  const openCustomers = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE lead_status NOT IN ('closed', 'lost')");
  const myTasks = db.prepare(`
    SELECT t.*, c.first_name, c.last_name FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.assigned_to = ? AND t.done_at IS NULL AND (t.due_date IS NULL OR t.due_date <= ?)
    ORDER BY t.due_date IS NULL, t.due_date, t.id LIMIT 15
  `);
  const followUps = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.phone, c.follow_up_date, c.lead_status, s.full_name AS salesperson_name
    FROM customers c LEFT JOIN users s ON s.id = c.salesperson_id
    WHERE c.follow_up_date IS NOT NULL AND c.follow_up_date <= @today AND c.lead_status NOT IN ('closed', 'lost')
      AND (@all = 1 OR c.salesperson_id = @me OR c.salesperson_id IS NULL)
    ORDER BY c.follow_up_date LIMIT 15
  `);
  const pendingDeals = db.prepare(`
    SELECT d.*, c.first_name, c.last_name, i.stock_number, i.manufacturer, i.model, u.full_name AS salesperson_name
    FROM deals d JOIN customers c ON c.id = d.customer_id JOIN inventory i ON i.id = d.inventory_id
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.status = 'pending' AND (@all = 1 OR d.salesperson_id = @me)
    ORDER BY d.created_at DESC LIMIT 10
  `);
  const soldThisMonth = db.prepare(`
    SELECT d.*, i.invoice_cost, i.freight_cost, i.other_cost FROM deals d JOIN inventory i ON i.id = d.inventory_id
    WHERE d.status = 'sold' AND date(d.sold_at, 'localtime') >= @from AND (@all = 1 OR d.salesperson_id = @me)
  `);
  const collectedThisMonth = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0) AS total FROM payments
    WHERE voided_at IS NULL AND received_on >= ?
  `);
  const newLeads = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE date(created_at, 'localtime') >= ?");
  const itemsStmt = db.prepare('SELECT price, cost, taxable FROM deal_items WHERE deal_id = ?');
  const paymentsStmt = db.prepare('SELECT kind, amount, voided_at FROM payments WHERE deal_id = ?');

  router.get('/', (req, res) => {
    const isManager = req.user.role === 'manager';
    const params = { all: isManager ? 1 : 0, me: req.user.id, today: today() };
    const monthFrom = today().slice(0, 8) + '01';

    const counts = { available: 0, pending: 0, sold: 0 };
    for (const row of statusCounts.all()) counts[row.status] = row.n;

    const withTotals = (d) => ({
      ...d,
      totals: dealTotals(d, itemsStmt.all(d.id), paymentsStmt.all(d.id), d),
    });
    const sold = soldThisMonth.all({ ...params, from: monthFrom }).map(withTotals);
    const month = {
      units: sold.length,
      revenue: round2(sold.reduce((s, d) => s + d.totals.homeNet + d.totals.itemsTotal + d.doc_fee, 0)),
      grossProfit: isManager ? round2(sold.reduce((s, d) => s + d.totals.grossProfit, 0)) : null,
      collected: isManager ? collectedThisMonth.get(monthFrom).total : null,
      newLeads: newLeads.get(monthFrom).n,
    };

    res.render('dashboard', {
      title: 'Dashboard',
      counts,
      openCustomers: openCustomers.get().n,
      tasks: myTasks.all(req.user.id, today()),
      followUps: followUps.all(params),
      pending: pendingDeals.all(params).map(withTotals),
      month,
      todayStr: today(),
    });
  });

  return router;
};
