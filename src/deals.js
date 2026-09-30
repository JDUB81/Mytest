// Deal math and shared record-keeping helpers used across routes.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function logActivity(db, { userId, customerId = null, inventoryId = null, dealId = null, message }) {
  db.prepare(
    'INSERT INTO activity (user_id, customer_id, inventory_id, deal_id, message) VALUES (?, ?, ?, ?, ?)'
  ).run(userId || null, customerId, inventoryId, dealId, message);
}

// Everything on the buyer's order is derived here so the deal page, the printout,
// and the reports can never disagree.
//   home net     = sale price − discount
//   taxable base = home net + taxable add-ons − trade allowance (never below 0)
//   total        = home net + add-ons + doc fee + tax − (trade allowance − trade payoff)
//   paid         = deposits + payments − refunds (voided entries ignored)
function dealTotals(deal, items = [], payments = [], home = null) {
  const homeNet = round2(deal.sale_price - deal.discount);
  const itemsTotal = round2(items.reduce((sum, i) => sum + i.price, 0));
  const taxableItems = round2(items.filter((i) => i.taxable).reduce((sum, i) => sum + i.price, 0));
  const taxableBase = Math.max(0, round2(homeNet + taxableItems - deal.trade_allowance));
  const tax = round2((taxableBase * deal.tax_rate) / 100);
  const netTrade = round2(deal.trade_allowance - deal.trade_payoff);
  const total = round2(homeNet + itemsTotal + deal.doc_fee + tax - netTrade);

  let paid = 0;
  let deposits = 0;
  for (const p of payments) {
    if (p.voided_at) continue;
    if (p.kind === 'refund') paid -= p.amount;
    else paid += p.amount;
    if (p.kind === 'deposit') deposits += p.amount;
  }
  paid = round2(paid);

  const totals = {
    homeNet,
    itemsTotal,
    taxableItems,
    taxableBase,
    tax,
    netTrade,
    total,
    paid,
    deposits: round2(deposits),
    balance: round2(total - paid),
  };

  // Gross profit (manager-only view). Unknown costs count as zero; trade-ins are
  // excluded because their value isn't known until the trade is resold.
  if (home) {
    const homeCost = round2((home.invoice_cost || 0) + (home.freight_cost || 0) + (home.other_cost || 0));
    const itemsCost = round2(items.reduce((sum, i) => sum + (i.cost || 0), 0));
    totals.homeCost = homeCost;
    totals.itemsCost = itemsCost;
    totals.grossProfit = round2(homeNet + itemsTotal + deal.doc_fee - homeCost - itemsCost);
    totals.costKnown = home.invoice_cost !== null && home.invoice_cost !== undefined;
  }
  return totals;
}

function loadDealBundle(db, dealId) {
  const deal = db
    .prepare(`
      SELECT d.*, c.first_name, c.last_name, c.phone, c.email, c.address, c.city, c.state, c.zip,
             c.co_buyer_name, c.co_buyer_phone, c.co_buyer_email,
             u.full_name AS salesperson_name
      FROM deals d
      JOIN customers c ON c.id = d.customer_id
      LEFT JOIN users u ON u.id = d.salesperson_id
      WHERE d.id = ?
    `)
    .get(dealId);
  if (!deal) return null;
  const home = db.prepare('SELECT * FROM inventory WHERE id = ?').get(deal.inventory_id);
  const items = db.prepare('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY id').all(deal.id);
  const payments = db
    .prepare(`
      SELECT p.*, u.full_name AS received_by_name, v.full_name AS voided_by_name
      FROM payments p
      LEFT JOIN users u ON u.id = p.received_by
      LEFT JOIN users v ON v.id = p.voided_by
      WHERE p.deal_id = ? ORDER BY p.received_on, p.id
    `)
    .all(deal.id);
  return { deal, home, items, payments, totals: dealTotals(deal, items, payments, home) };
}

// Local calendar date as YYYY-MM-DD (the sales center's time zone, not UTC).
function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { round2, logActivity, dealTotals, loadDealBundle, today };
