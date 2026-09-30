const express = require('express');
const { requireRole } = require('../auth');
const { LEAD_STATUSES, FINANCING_TYPES, PAYMENT_KINDS, PAYMENT_METHODS } = require('../db');
const { date, daysSince } = require('../format');
const { dealTotals, round2, today } = require('../deals');
const { dealFinancials } = require('../books');

function monthStart(offsetMonths = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function monthEnd(offsetMonths = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths + 1);
  d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PRESETS = {
  this_month: () => [monthStart(0), today()],
  last_month: () => [monthStart(-1), monthEnd(-1)],
  ytd: () => [`${new Date().getFullYear()}-01-01`, today()],
  last_12: () => [monthStart(-11), today()],
};

// CSV cell: quote everything and neutralize spreadsheet formulas in text.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function sendCsv(res, filename, header, rows) {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + lines.join('\r\n'));
}

module.exports = function reportRoutes(db) {
  const router = express.Router();
  router.use(requireRole('manager'));

  const soldDealsStmt = db.prepare(`
    SELECT d.*, c.first_name, c.last_name, c.lead_source, i.stock_number, i.manufacturer, i.model, i.year,
           i.home_type, i.invoice_cost, i.freight_cost, i.other_cost, i.arrival_date, i.created_at AS home_created_at,
           u.full_name AS salesperson_name
    FROM deals d
    JOIN customers c ON c.id = d.customer_id
    JOIN inventory i ON i.id = d.inventory_id
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.status = 'sold' AND date(d.sold_at, 'localtime') BETWEEN @from AND @to
    ORDER BY d.sold_at
  `);
  const itemsStmt = db.prepare('SELECT price, cost, taxable FROM deal_items WHERE deal_id = ?');
  const paymentsStmt = db.prepare('SELECT kind, amount, voided_at FROM payments WHERE deal_id = ?');

  function withTotals(deal) {
    return { ...deal, totals: dealTotals(deal, itemsStmt.all(deal.id), paymentsStmt.all(deal.id), deal) };
  }

  function range(req) {
    const preset = PRESETS[req.query.preset] ? req.query.preset : null;
    let [from, to] = PRESETS[preset || 'this_month']();
    if (!preset) {
      const f = date(req.query.from);
      const t = date(req.query.to);
      if (f.value) from = f.value;
      if (t.value) to = t.value;
    }
    if (from > to) [from, to] = [to, from];
    return { from, to, preset: preset || (req.query.from || req.query.to ? 'custom' : 'this_month') };
  }

  router.get('/', (req, res) => {
    const { from, to, preset } = range(req);

    const sold = soldDealsStmt.all({ from, to }).map(withTotals);
    const revenue = (d) => round2(d.totals.homeNet + d.totals.itemsTotal + d.doc_fee);
    const summary = {
      units: sold.length,
      revenue: round2(sold.reduce((s, d) => s + revenue(d), 0)),
      grossProfit: round2(sold.reduce((s, d) => s + d.totals.grossProfit, 0)),
      missingCost: sold.filter((d) => !d.totals.costKnown).length,
      avgDaysToSell: sold.length
        ? Math.round(
            sold.reduce((s, d) => {
              const start = d.arrival_date || d.home_created_at;
              return s + Math.max(0, (daysSince(start) ?? 0) - (daysSince(d.sold_at) ?? 0));
            }, 0) / sold.length
          )
        : null,
    };

    const bySalesperson = {};
    for (const d of sold) {
      const key = d.salesperson_name || 'Unassigned';
      const row = (bySalesperson[key] ||= { name: key, units: 0, revenue: 0, grossProfit: 0, overruns: 0, commission: 0 });
      const fin = dealFinancials(db, d.id);
      row.units += 1;
      row.revenue = round2(row.revenue + revenue(d));
      row.grossProfit = round2(row.grossProfit + d.totals.grossProfit);
      row.overruns = round2(row.overruns + fin.jobs.overrun);
      row.commission = round2(row.commission + (fin.commission ? fin.commission.net : 0));
    }

    const byFinancing = {};
    for (const d of sold) {
      const key = FINANCING_TYPES[d.financing_type] || 'Not set';
      byFinancing[key] = (byFinancing[key] || 0) + 1;
    }

    const leadSources = db
      .prepare(`
        SELECT COALESCE(lead_source, 'Not recorded') AS source, COUNT(*) AS leads,
               SUM(CASE WHEN lead_status = 'closed' THEN 1 ELSE 0 END) AS closed
        FROM customers WHERE date(created_at, 'localtime') BETWEEN @from AND @to
        GROUP BY 1 ORDER BY leads DESC
      `)
      .all({ from, to });

    const payments = db
      .prepare(`
        SELECT kind, method, COUNT(*) AS n, SUM(amount) AS total FROM payments
        WHERE voided_at IS NULL AND received_on BETWEEN @from AND @to
        GROUP BY kind, method ORDER BY kind, total DESC
      `)
      .all({ from, to });
    const paymentsNet = round2(payments.reduce((s, p) => s + (p.kind === 'refund' ? -p.total : p.total), 0));

    // Always shown regardless of date range.
    const monthly = [];
    for (let m = -11; m <= 0; m++) {
      const rows = soldDealsStmt.all({ from: monthStart(m), to: monthEnd(m) }).map(withTotals);
      monthly.push({
        month: monthStart(m).slice(0, 7),
        units: rows.length,
        revenue: round2(rows.reduce((s, d) => s + revenue(d), 0)),
        grossProfit: round2(rows.reduce((s, d) => s + d.totals.grossProfit, 0)),
      });
    }

    const available = db
      .prepare("SELECT *, COALESCE(arrival_date, date(created_at, 'localtime')) AS on_lot_since FROM inventory WHERE status = 'available'")
      .all()
      .map((h) => ({ ...h, days: daysSince(h.on_lot_since) ?? 0 }));
    const aging = [
      { label: '0–30 days', min: 0, max: 30 },
      { label: '31–60 days', min: 31, max: 60 },
      { label: '61–90 days', min: 61, max: 90 },
      { label: '90+ days', min: 91, max: Infinity },
    ].map((b) => {
      const homes = available.filter((h) => h.days >= b.min && h.days <= b.max);
      return {
        ...b,
        count: homes.length,
        listValue: round2(homes.reduce((s, h) => s + (h.price || 0), 0)),
        cost: round2(homes.reduce((s, h) => s + (h.invoice_cost || 0) + (h.freight_cost || 0) + (h.other_cost || 0), 0)),
      };
    });
    const stale = available.filter((h) => h.days > 90).sort((a, b) => b.days - a.days);

    const pending = db
      .prepare(`
        SELECT d.*, i.invoice_cost, i.freight_cost, i.other_cost FROM deals d
        JOIN inventory i ON i.id = d.inventory_id WHERE d.status = 'pending'
      `)
      .all()
      .map(withTotals);
    const pipeline = {
      count: pending.length,
      value: round2(pending.reduce((s, d) => s + d.totals.total, 0)),
      deposits: round2(pending.reduce((s, d) => s + d.totals.paid, 0)),
    };

    const stageCounts = db.prepare('SELECT lead_status, COUNT(*) AS n FROM customers GROUP BY lead_status').all();

    res.render('reports/index', {
      title: 'Reports',
      from,
      to,
      preset,
      summary,
      sold,
      bySalesperson: Object.values(bySalesperson).sort((a, b) => b.revenue - a.revenue),
      byFinancing,
      leadSources,
      payments,
      paymentsNet,
      monthly,
      aging,
      stale,
      pipeline,
      stageCounts,
    });
  });

  router.get('/export/customers.csv', (req, res) => {
    const rows = db
      .prepare(`
        SELECT c.*, s.full_name AS salesperson FROM customers c LEFT JOIN users s ON s.id = c.salesperson_id
        ORDER BY c.last_name, c.first_name
      `)
      .all();
    sendCsv(
      res,
      `customers-${today()}.csv`,
      ['ID', 'First name', 'Last name', 'Phone', 'Email', 'Address', 'City', 'State', 'ZIP', 'Stage', 'Source',
        'Salesperson', 'Budget', 'Bedrooms wanted', 'Land', 'Financing', 'Follow-up', 'Co-buyer', 'Co-buyer phone',
        'Created'],
      rows.map((c) => [
        c.id, c.first_name, c.last_name, c.phone, c.email, c.address, c.city, c.state, c.zip,
        LEAD_STATUSES[c.lead_status] || c.lead_status, c.lead_source, c.salesperson, c.budget, c.desired_bedrooms,
        c.land_status, FINANCING_TYPES[c.financing_pref] || '', c.follow_up_date, c.co_buyer_name, c.co_buyer_phone,
        c.created_at,
      ])
    );
  });

  router.get('/export/inventory.csv', (req, res) => {
    const rows = db
      .prepare(`
        SELECT i.*, c.first_name, c.last_name FROM inventory i LEFT JOIN customers c ON c.id = i.customer_id
        ORDER BY i.stock_number
      `)
      .all();
    sendCsv(
      res,
      `inventory-${today()}.csv`,
      ['Stock #', 'Status', 'Year', 'Manufacturer', 'Model', 'Type', 'Serial/VIN', 'Beds', 'Baths', 'Sq ft', 'Width',
        'Length', 'List price', 'Invoice cost', 'Freight', 'Other cost', 'Location', 'Arrival date', 'Customer', 'Added'],
      rows.map((h) => [
        h.stock_number, h.status, h.year, h.manufacturer, h.model, h.home_type, h.serial_number, h.bedrooms,
        h.bathrooms, h.square_feet, h.width_ft, h.length_ft, h.price, h.invoice_cost, h.freight_cost, h.other_cost,
        h.location, h.arrival_date, h.customer_id ? `${h.first_name} ${h.last_name}` : '', h.created_at,
      ])
    );
  });

  router.get('/export/sales.csv', (req, res) => {
    const { from, to } = range(req);
    const rows = soldDealsStmt.all({ from, to }).map(withTotals);
    sendCsv(
      res,
      `sales-${from}-to-${to}.csv`,
      ['Deal #', 'Sold', 'Customer', 'Stock #', 'Home', 'Salesperson', 'Financing', 'Lender', 'Sale price',
        'Discount', 'Add-ons', 'Doc fee', 'Tax', 'Trade allowance', 'Trade payoff', 'Total', 'Paid', 'Balance',
        'Home cost', 'Add-on cost', 'Gross profit'],
      rows.map((d) => [
        d.id, d.sold_at, `${d.first_name} ${d.last_name}`, d.stock_number, `${d.year || ''} ${d.manufacturer} ${d.model}`.trim(),
        d.salesperson_name, FINANCING_TYPES[d.financing_type] || '', d.lender, d.sale_price, d.discount,
        d.totals.itemsTotal, d.doc_fee, d.totals.tax, d.trade_allowance, d.trade_payoff, d.totals.total,
        d.totals.paid, d.totals.balance, d.totals.homeCost, d.totals.itemsCost, d.totals.grossProfit,
      ])
    );
  });

  router.get('/export/payments.csv', (req, res) => {
    const { from, to } = range(req);
    const rows = db
      .prepare(`
        SELECT p.*, c.first_name, c.last_name, i.stock_number, u.full_name AS received_by_name
        FROM payments p JOIN deals d ON d.id = p.deal_id
        JOIN customers c ON c.id = d.customer_id JOIN inventory i ON i.id = d.inventory_id
        LEFT JOIN users u ON u.id = p.received_by
        WHERE p.received_on BETWEEN @from AND @to ORDER BY p.received_on, p.id
      `)
      .all({ from, to });
    sendCsv(
      res,
      `payments-${from}-to-${to}.csv`,
      ['Receipt #', 'Date', 'Type', 'Method', 'Amount', 'Reference', 'Customer', 'Stock #', 'Deal #', 'Received by', 'Voided', 'Void reason'],
      rows.map((p) => [
        p.id, p.received_on, PAYMENT_KINDS[p.kind], PAYMENT_METHODS[p.method] || p.method,
        p.kind === 'refund' ? -p.amount : p.amount, p.reference, `${p.first_name} ${p.last_name}`, p.stock_number,
        p.deal_id, p.received_by_name, p.voided_at ? 'Yes' : '', p.void_reason,
      ])
    );
  });

  router.get('/activity', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 100;
    const rows = db
      .prepare(`
        SELECT a.*, u.full_name AS author, c.first_name, c.last_name, i.stock_number
        FROM activity a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN customers c ON c.id = a.customer_id
        LEFT JOIN inventory i ON i.id = a.inventory_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?
      `)
      .all(perPage + 1, (page - 1) * perPage);
    res.render('reports/activity', {
      title: 'Activity log',
      rows: rows.slice(0, perPage),
      page,
      hasMore: rows.length > perPage,
    });
  });

  return router;
};
