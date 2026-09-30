const express = require('express');
const { requireRole } = require('../auth');
const { FINANCING_TYPES, PAYMENT_KINDS, PAYMENT_METHODS } = require('../db');
const { text, number, date, choice } = require('../format');
const { logActivity, loadDealBundle, dealTotals, round2, today } = require('../deals');
const { dealFinancials, syncDealCommission } = require('../books');

const managerOnly = requireRole('manager');
const MONEY = { max: 100000000 };

module.exports = function dealRoutes(db) {
  const router = express.Router();

  const salespeople = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name');
  const updateDeal = db.prepare(`
    UPDATE deals SET salesperson_id = @salesperson_id, sale_price = @sale_price, discount = @discount,
      trade_description = @trade_description, trade_allowance = @trade_allowance, trade_payoff = @trade_payoff,
      tax_rate = @tax_rate, doc_fee = @doc_fee, financing_type = @financing_type, lender = @lender,
      delivery_date = @delivery_date, delivery_address = @delivery_address, notes = @notes,
      updated_at = datetime('now')
    WHERE id = @id
  `);
  const insertItem = db.prepare(
    'INSERT INTO deal_items (deal_id, description, price, cost, taxable, catalog_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const updateItem = db.prepare('UPDATE deal_items SET description = ?, price = ?, cost = ?, taxable = ? WHERE id = ? AND deal_id = ?');
  const itemHasPayments = db.prepare('SELECT 1 FROM expenses WHERE deal_item_id = ? AND voided_at IS NULL LIMIT 1');
  const catalogItem = db.prepare('SELECT * FROM addon_catalog WHERE id = ?');
  const activeCatalog = db.prepare('SELECT * FROM addon_catalog WHERE active = 1 ORDER BY category, name');
  const deleteItem = db.prepare('DELETE FROM deal_items WHERE id = ? AND deal_id = ?');
  const selectItem = db.prepare('SELECT * FROM deal_items WHERE id = ? AND deal_id = ?');
  const insertPayment = db.prepare(`
    INSERT INTO payments (deal_id, kind, amount, method, reference, received_on, notes, received_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectPayment = db.prepare('SELECT * FROM payments WHERE id = ? AND deal_id = ?');
  const voidPayment = db.prepare(`
    UPDATE payments SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL
  `);
  const touchDeal = db.prepare("UPDATE deals SET updated_at = datetime('now') WHERE id = ?");
  const markSold = db.prepare(`
    UPDATE deals SET status = 'sold', sold_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);
  const markHomeSold = db.prepare("UPDATE inventory SET status = 'sold', updated_at = datetime('now') WHERE id = ?");
  const cancelDeal = db.prepare(`
    UPDATE deals SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now')
    WHERE id = ? AND status != 'cancelled'
  `);
  const releaseHome = db.prepare(`
    UPDATE inventory SET customer_id = NULL, assigned_by = NULL, assigned_at = NULL, status = 'available',
      updated_at = datetime('now')
    WHERE id = ?
  `);
  const setLeadStatus = db.prepare("UPDATE customers SET lead_status = ?, updated_at = datetime('now') WHERE id = ?");
  const notesFor = db.prepare(`
    SELECT n.*, u.full_name AS author FROM notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.deal_id = ? ORDER BY n.created_at DESC, n.id DESC
  `);
  const activityFor = db.prepare(`
    SELECT a.*, u.full_name AS author FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC
  `);

  function loadDeal(req, res, next) {
    const bundle = loadDealBundle(db, Number(req.params.id));
    if (!bundle) return res.status(404).render('error', { title: 'Not found', message: 'That deal does not exist.' });
    req.bundle = bundle;
    next();
  }

  // Pending deals are open to both roles; once sold or cancelled only a manager may change them.
  function editable(req, res, next) {
    if (req.bundle.deal.status !== 'pending' && req.user.role !== 'manager') {
      req.flash('error', 'This deal is closed. Ask a manager to make changes.');
      return res.redirect(`/deals/${req.bundle.deal.id}`);
    }
    next();
  }

  function customerName(deal) {
    return `${deal.first_name} ${deal.last_name}`;
  }

  // Money figures in activity messages.
  const usd = (n) => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function viewBundle(req) {
    const { home, ...rest } = req.bundle;
    const isManager = req.user.role === 'manager';
    const totals = { ...rest.totals };
    if (!isManager) {
      delete totals.grossProfit;
      delete totals.homeCost;
      delete totals.itemsCost;
    }
    return {
      ...rest,
      totals,
      home: isManager ? home : { ...home, invoice_cost: undefined, freight_cost: undefined, other_cost: undefined },
    };
  }

  router.get('/', (req, res) => {
    const status = ['pending', 'sold', 'cancelled', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const mine = req.query.mine === '1';
    const where = [];
    const params = {};
    if (status !== 'all') {
      where.push('d.status = @status');
      params.status = status;
    }
    if (mine) {
      where.push('d.salesperson_id = @me');
      params.me = req.user.id;
    }
    const rows = db
      .prepare(`
        SELECT d.*, c.first_name, c.last_name, i.stock_number, i.manufacturer, i.model, i.year,
               i.invoice_cost, i.freight_cost, i.other_cost, u.full_name AS salesperson_name
        FROM deals d
        JOIN customers c ON c.id = d.customer_id
        JOIN inventory i ON i.id = d.inventory_id
        LEFT JOIN users u ON u.id = d.salesperson_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(d.sold_at, d.created_at) DESC, d.id DESC
      `)
      .all(params);
    const itemsStmt = db.prepare('SELECT price, cost, taxable FROM deal_items WHERE deal_id = ?');
    const paysStmt = db.prepare('SELECT kind, amount, voided_at FROM payments WHERE deal_id = ?');
    const deals = rows.map((d) => ({
      ...d,
      totals: dealTotals(d, itemsStmt.all(d.id), paysStmt.all(d.id), d),
    }));
    res.render('deals/index', { title: 'Deals', deals, status, mine });
  });

  router.get('/:id', loadDeal, (req, res) => {
    const { deal } = req.bundle;
    const isManager = req.user.role === 'manager';
    const catalog = activeCatalog.all().map((c) => (isManager ? c : { ...c, cost: undefined }));
    res.render('deals/show', {
      title: `Deal #${deal.id}`,
      ...viewBundle(req),
      notes: notesFor.all(deal.id),
      activity: activityFor.all(deal.id),
      catalog,
      financials: isManager ? dealFinancials(db, deal.id) : null,
    });
  });

  router.get('/:id/edit', loadDeal, editable, (req, res) => {
    res.render('deals/edit', { title: `Edit deal #${req.bundle.deal.id}`, ...viewBundle(req), errors: [], salespeople: salespeople.all() });
  });

  router.post('/:id', loadDeal, editable, (req, res) => {
    const { deal } = req.bundle;
    const errors = [];
    const money = (field, label, opts = MONEY) => {
      const parsed = number(req.body[field], opts);
      if (parsed.error) errors.push(`${label} must be a valid amount.`);
      return parsed.value ?? 0;
    };
    const values = {
      id: deal.id,
      sale_price: money('sale_price', 'Sale price'),
      discount: money('discount', 'Discount'),
      trade_allowance: money('trade_allowance', 'Trade-in allowance'),
      trade_payoff: money('trade_payoff', 'Trade-in payoff'),
      tax_rate: money('tax_rate', 'Tax rate', { max: 30 }),
      doc_fee: money('doc_fee', 'Doc fee'),
      trade_description: text(req.body.trade_description, 300),
      financing_type: choice(req.body.financing_type, FINANCING_TYPES),
      lender: text(req.body.lender, 120),
      delivery_address: text(req.body.delivery_address, 300),
      notes: text(req.body.notes, 4000),
      salesperson_id: Number(req.body.salesperson_id) || deal.salesperson_id,
    };
    const delivery = date(req.body.delivery_date);
    if (delivery.error) errors.push('Delivery date is invalid.');
    values.delivery_date = delivery.value || null;
    if (!salespeople.all().some((u) => u.id === values.salesperson_id)) values.salesperson_id = deal.salesperson_id;
    if (values.discount > values.sale_price) errors.push('Discount cannot be more than the sale price.');

    if (errors.length) {
      return res.status(400).render('deals/edit', {
        title: `Edit deal #${deal.id}`,
        ...viewBundle(req),
        deal: { ...deal, ...values, delivery_date: req.body.delivery_date },
        errors,
        salespeople: salespeople.all(),
      });
    }

    db.transaction(() => {
      updateDeal.run(values);
      const changes = [];
      if (values.sale_price !== deal.sale_price) changes.push(`sale price ${usd(deal.sale_price)} → ${usd(values.sale_price)}`);
      if (values.discount !== deal.discount) changes.push(`discount ${usd(deal.discount)} → ${usd(values.discount)}`);
      if (values.trade_allowance !== deal.trade_allowance) changes.push(`trade allowance → ${usd(values.trade_allowance)}`);
      if (values.tax_rate !== deal.tax_rate) changes.push(`tax rate → ${values.tax_rate}%`);
      if (values.financing_type !== deal.financing_type) {
        changes.push(`financing → ${FINANCING_TYPES[values.financing_type] || 'not set'}`);
      }
      logActivity(db, {
        userId: req.user.id,
        customerId: deal.customer_id,
        inventoryId: deal.inventory_id,
        dealId: deal.id,
        message: changes.length ? `Updated deal: ${changes.join(', ')}` : 'Updated deal details',
      });
    })();
    syncDealCommission(db, deal.id, req.user.id);
    req.flash('success', 'Deal updated.');
    res.redirect(`/deals/${deal.id}`);
  });

  router.post('/:id/items', loadDeal, editable, (req, res) => {
    const { deal } = req.bundle;
    // A price-list pick fills in the defaults; anything typed on the form wins.
    const preset = req.body.catalog_id ? catalogItem.get(Number(req.body.catalog_id)) : null;
    const description = text(req.body.description, 200) || (preset && preset.name);
    let price = number(req.body.price, { min: -MONEY.max, max: MONEY.max });
    if (price.value === null && preset && preset.price) price = { value: preset.price };
    let cost;
    if (req.user.role === 'manager') {
      cost = number(req.body.cost, MONEY);
      if (cost.value === null && preset) cost = { value: preset.cost };
    } else {
      // Sales associates never see or set cost; the price list's allotment applies.
      cost = { value: preset ? preset.cost : null };
    }
    if (!description || price.error || price.value === null || cost.error) {
      req.flash('error', 'Enter a description and a valid price for the add-on.');
      return res.redirect(`/deals/${deal.id}#items`);
    }
    insertItem.run(deal.id, description, price.value, cost.value, req.body.taxable === '1' ? 1 : 0, preset ? preset.id : null);
    touchDeal.run(deal.id);
    syncDealCommission(db, deal.id, req.user.id);
    logActivity(db, {
      userId: req.user.id,
      customerId: deal.customer_id,
      inventoryId: deal.inventory_id,
      dealId: deal.id,
      message: `Added "${description}" (${usd(price.value)}) to deal`,
    });
    res.redirect(`/deals/${deal.id}#items`);
  });

  router.post('/:id/items/:itemId', loadDeal, editable, (req, res) => {
    const { deal } = req.bundle;
    const item = selectItem.get(Number(req.params.itemId), deal.id);
    if (!item) return res.redirect(`/deals/${deal.id}#items`);
    const description = text(req.body.description, 200) || item.description;
    const price = number(req.body.price, { min: -MONEY.max, max: MONEY.max });
    const cost = req.user.role === 'manager' ? number(req.body.cost, MONEY) : { value: item.cost };
    if (price.error || price.value === null || cost.error) {
      req.flash('error', 'Enter a valid price.');
      return res.redirect(`/deals/${deal.id}#items`);
    }
    const taxable = req.body.taxable === '1' ? 1 : 0;
    updateItem.run(description, price.value, cost.value, taxable, item.id, deal.id);
    touchDeal.run(deal.id);
    const changes = [];
    if (price.value !== item.price) changes.push(`price ${usd(item.price)} → ${usd(price.value)}`);
    if (cost.value !== item.cost) changes.push(`allotted cost ${item.cost == null ? 'none' : usd(item.cost)} → ${cost.value == null ? 'none' : usd(cost.value)}`);
    logActivity(db, {
      userId: req.user.id,
      customerId: deal.customer_id,
      inventoryId: deal.inventory_id,
      dealId: deal.id,
      message: `Updated "${description}"${changes.length ? ': ' + changes.join(', ') : ''}`,
    });
    syncDealCommission(db, deal.id, req.user.id);
    res.redirect(`/deals/${deal.id}#items`);
  });

  router.post('/:id/items/:itemId/delete', loadDeal, editable, (req, res) => {
    const { deal } = req.bundle;
    const item = selectItem.get(Number(req.params.itemId), deal.id);
    if (item && itemHasPayments.get(item.id)) {
      req.flash('error', `Checks have been written against "${item.description}", so it can\u2019t be removed. Void those checks first.`);
      return res.redirect(`/deals/${deal.id}#items`);
    }
    if (item) {
      deleteItem.run(item.id, deal.id);
      touchDeal.run(deal.id);
      syncDealCommission(db, deal.id, req.user.id);
      logActivity(db, {
        userId: req.user.id,
        customerId: deal.customer_id,
        inventoryId: deal.inventory_id,
        dealId: deal.id,
        message: `Removed "${item.description}" (${usd(item.price)}) from deal`,
      });
    }
    res.redirect(`/deals/${deal.id}#items`);
  });

  // Both roles can take deposits and payments at the desk; refunds are manager-only.
  router.post('/:id/payments', loadDeal, (req, res) => {
    const { deal, totals } = req.bundle;
    const kind = choice(req.body.kind, PAYMENT_KINDS);
    const method = choice(req.body.method, PAYMENT_METHODS);
    const amount = number(req.body.amount, { min: 0.01, max: MONEY.max });
    const received = date(req.body.received_on);
    let error = null;
    if (!kind || !method) error = 'Choose a payment type and method.';
    else if (amount.error || !amount.value) error = 'Enter a valid amount.';
    else if (received.error) error = 'Date received is invalid.';
    else if (kind === 'refund' && req.user.role !== 'manager') error = 'Only a manager can record a refund.';
    else if (kind === 'refund' && amount.value > totals.paid) error = 'Refund cannot be more than what has been paid.';
    else if (deal.status === 'cancelled' && kind !== 'refund') error = 'This deal is cancelled; only refunds can be recorded.';
    if (error) {
      req.flash('error', error);
      return res.redirect(`/deals/${deal.id}#payments`);
    }
    const info = insertPayment.run(
      deal.id,
      kind,
      round2(amount.value),
      method,
      text(req.body.reference, 100),
      received.value || today(),
      text(req.body.notes, 500),
      req.user.id
    );
    touchDeal.run(deal.id);
    logActivity(db, {
      userId: req.user.id,
      customerId: deal.customer_id,
      inventoryId: deal.inventory_id,
      dealId: deal.id,
      message: `Recorded ${PAYMENT_KINDS[kind].toLowerCase()} of ${usd(amount.value)} (${PAYMENT_METHODS[method]})`,
    });
    req.flash('success', `${PAYMENT_KINDS[kind]} of ${usd(amount.value)} recorded.`, {
      href: `/deals/${deal.id}/payments/${info.lastInsertRowid}/receipt`,
      label: 'Print receipt',
    });
    res.redirect(`/deals/${deal.id}#payments`);
  });

  router.post('/:id/payments/:paymentId/void', managerOnly, loadDeal, (req, res) => {
    const { deal } = req.bundle;
    const payment = selectPayment.get(Number(req.params.paymentId), deal.id);
    const reason = text(req.body.reason, 300);
    if (!payment || !reason) {
      req.flash('error', 'Give a reason for voiding the payment.');
      return res.redirect(`/deals/${deal.id}#payments`);
    }
    if (voidPayment.run(req.user.id, reason, payment.id).changes) {
      logActivity(db, {
        userId: req.user.id,
        customerId: deal.customer_id,
        inventoryId: deal.inventory_id,
        dealId: deal.id,
        message: `Voided ${PAYMENT_KINDS[payment.kind].toLowerCase()} of ${usd(payment.amount)}: ${reason}`,
      });
      req.flash('success', 'Payment voided.');
    }
    res.redirect(`/deals/${deal.id}#payments`);
  });

  router.post('/:id/sold', managerOnly, loadDeal, (req, res) => {
    const { deal, totals } = req.bundle;
    const ok = db.transaction(() => {
      if (markSold.run(deal.id).changes === 0) return false;
      markHomeSold.run(deal.inventory_id);
      setLeadStatus.run('closed', deal.customer_id);
      logActivity(db, {
        userId: req.user.id,
        customerId: deal.customer_id,
        inventoryId: deal.inventory_id,
        dealId: deal.id,
        message: `Marked sold to ${customerName(deal)} for ${usd(totals.total)}`,
      });
      syncDealCommission(db, deal.id, req.user.id);
      return true;
    })();
    if (!ok) req.flash('error', 'Only a pending deal can be marked sold.');
    else if (totals.balance > 0) {
      req.flash('success', `Deal marked sold. Note: ${usd(totals.balance)} is still outstanding.`);
    } else req.flash('success', 'Deal marked sold. Congratulations!');
    res.redirect(`/deals/${deal.id}`);
  });

  router.post('/:id/cancel', managerOnly, loadDeal, (req, res) => {
    const { deal, totals, home } = req.bundle;
    const reason = text(req.body.reason, 300);
    if (!reason) {
      req.flash('error', 'Give a reason for cancelling the deal.');
      return res.redirect(`/deals/${deal.id}`);
    }
    const ok = db.transaction(() => {
      if (cancelDeal.run(reason, deal.id).changes === 0) return false;
      if (home.customer_id === deal.customer_id) releaseHome.run(deal.inventory_id);
      setLeadStatus.run('approved', deal.customer_id);
      logActivity(db, {
        userId: req.user.id,
        customerId: deal.customer_id,
        inventoryId: deal.inventory_id,
        dealId: deal.id,
        message: `Cancelled deal; stock #${home.stock_number} is available again. Reason: ${reason}`,
      });
      syncDealCommission(db, deal.id, req.user.id);
      return true;
    })();
    if (!ok) req.flash('error', 'This deal is already cancelled.');
    else if (totals.paid > 0) {
      req.flash('success', `Deal cancelled and home released. ${usd(totals.paid)} was collected — record a refund if one is owed.`);
    } else req.flash('success', 'Deal cancelled and home released back to inventory.');
    res.redirect(`/deals/${deal.id}`);
  });

  router.get('/:id/print', loadDeal, (req, res) => {
    res.render('deals/print', { title: `Buyer's order #${req.bundle.deal.id}`, ...viewBundle(req) });
  });

  router.get('/:id/payments/:paymentId/receipt', loadDeal, (req, res) => {
    const payment = req.bundle.payments.find((p) => p.id === Number(req.params.paymentId));
    if (!payment) return res.status(404).render('error', { title: 'Not found', message: 'That payment does not exist.' });
    res.render('deals/receipt', { title: `Receipt #${payment.id}`, ...viewBundle(req), payment });
  });

  return router;
};
