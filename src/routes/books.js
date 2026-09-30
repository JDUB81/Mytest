const express = require('express');
const { requireRole } = require('../auth');
const { EXPENSE_CATEGORIES, EXPENSE_METHODS, COMMISSION_PLANS, getSettings } = require('../db');
const { text, number, date, choice } = require('../format');
const { logActivity, round2, today } = require('../deals');
const books = require('../books');

const MONEY = { min: 0.01, max: 100000000 };
const usd = (n) =>
  (n < 0 ? '\u2212$' : '$') + Math.abs(round2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = function bookRoutes(db) {
  const router = express.Router();
  router.use(requireRole('manager'));

  const vendorsStmt = db.prepare('SELECT * FROM vendors ORDER BY active DESC, name');
  const activeVendors = db.prepare('SELECT * FROM vendors WHERE active = 1 ORDER BY name');
  const selectVendor = db.prepare('SELECT * FROM vendors WHERE id = ?');
  const staffStmt = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name');
  const openDeals = db.prepare(`
    SELECT d.id, d.status, c.first_name, c.last_name, i.stock_number, i.manufacturer, i.model
    FROM deals d JOIN customers c ON c.id = d.customer_id JOIN inventory i ON i.id = d.inventory_id
    WHERE d.status != 'cancelled' ORDER BY d.id DESC
  `);
  const selectExpense = db.prepare(`
    SELECT e.*, v.name AS vendor_name, v.address AS vendor_address, u.full_name AS created_by_name,
           vb.full_name AS voided_by_name, di.description AS item_description,
           c.first_name, c.last_name, i.stock_number
    FROM expenses e
    LEFT JOIN vendors v ON v.id = e.vendor_id
    LEFT JOIN users u ON u.id = e.created_by
    LEFT JOIN users vb ON vb.id = e.voided_by
    LEFT JOIN deal_items di ON di.id = e.deal_item_id
    LEFT JOIN deals d ON d.id = e.deal_id
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN inventory i ON i.id = COALESCE(e.inventory_id, d.inventory_id)
    WHERE e.id = ?
  `);
  const insertExpense = db.prepare(`
    INSERT INTO expenses (paid_on, amount, method, check_number, vendor_id, payee_user_id, payee_name, category,
      memo, deal_id, deal_item_id, inventory_id, created_by)
    VALUES (@paid_on, @amount, @method, @check_number, @vendor_id, @payee_user_id, @payee_name, @category,
      @memo, @deal_id, @deal_item_id, @inventory_id, @created_by)
  `);
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  // --- Check register -------------------------------------------------------

  router.get('/', (req, res) => res.redirect('/books/register'));

  router.get('/register', (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : req.query.month === 'all' ? 'all' : today().slice(0, 7);
    const category = choice(req.query.category, EXPENSE_CATEGORIES) || '';
    const vendorId = Number(req.query.vendor) || null;
    const q = text(req.query.q, 100);
    const where = [];
    const params = {};
    if (month !== 'all') {
      where.push("strftime('%Y-%m', e.paid_on) = @month");
      params.month = month;
    }
    if (category) {
      where.push('e.category = @category');
      params.category = category;
    }
    if (vendorId) {
      where.push('e.vendor_id = @vendor');
      params.vendor = vendorId;
    }
    if (q) {
      where.push('(e.payee_name LIKE @q OR e.memo LIKE @q OR e.check_number LIKE @q)');
      params.q = `%${q}%`;
    }
    const rows = db
      .prepare(`
        SELECT e.*, di.description AS item_description, c.last_name, i.stock_number
        FROM expenses e
        LEFT JOIN deal_items di ON di.id = e.deal_item_id
        LEFT JOIN deals d ON d.id = e.deal_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN inventory i ON i.id = COALESCE(e.inventory_id, d.inventory_id)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY e.paid_on DESC, e.id DESC
      `)
      .all(params);
    const total = round2(rows.filter((r) => !r.voided_at).reduce((s, r) => s + r.amount, 0));
    const byCategory = {};
    for (const r of rows) if (!r.voided_at) byCategory[r.category] = round2((byCategory[r.category] || 0) + r.amount);
    const months = db.prepare("SELECT DISTINCT strftime('%Y-%m', paid_on) AS m FROM expenses ORDER BY m DESC").all().map((r) => r.m);
    if (!months.includes(today().slice(0, 7))) months.unshift(today().slice(0, 7));
    res.render('books/register', {
      title: 'Check register',
      rows,
      total,
      byCategory,
      months,
      vendors: vendorsStmt.all(),
      filters: { month, category, vendor: vendorId || '', q: q || '' },
      monthLabel: books.monthLabel,
    });
  });

  // --- Write a check ----------------------------------------------------------

  function checkForm(req, res, status, values, errors) {
    const dealId = Number(values.deal_id) || null;
    const financials = dealId ? books.dealFinancials(db, dealId) : null;
    // For a pending deal the commission isn't locked in yet; show the salesperson's current rate.
    let commissionRate = financials && financials.commission ? financials.commission.rate : null;
    if (financials && !financials.commission && financials.deal.salesperson_id) {
      const sp = db.prepare('SELECT * FROM users WHERE id = ?').get(financials.deal.salesperson_id);
      if (sp && sp.commission_plan === 'sales') commissionRate = books.userRate(db, sp);
    }
    const settings = getSettings(db);
    res.status(status).render('books/check-form', {
      title: 'Write a check',
      values: { paid_on: today(), method: 'check', check_number: settings.next_check_number, ...values },
      errors,
      vendors: activeVendors.all(),
      staff: staffStmt.all(),
      deals: openDeals.all(),
      financials,
      commissionRate,
      // Default vendor for each job line, from the jobs list.
      lineVendors: financials
        ? Object.fromEntries(
            financials.items
              .filter((i) => i.catalog_id)
              .map((i) => [i.id, (db.prepare('SELECT vendor_id FROM addon_catalog WHERE id = ?').get(i.catalog_id) || {}).vendor_id])
              .filter(([, v]) => v)
          )
        : {},
    });
  }

  router.get('/checks/new', (req, res) => {
    const values = { deal_id: req.query.deal_id || '', vendor_id: req.query.vendor_id || '', deal_item_id: req.query.item || '' };
    if (values.deal_id) values.category = 'job';
    if (req.query.payee_user_id) {
      values.payee_type = 'staff';
      values.payee_user_id = req.query.payee_user_id;
      values.category = 'commission';
    }
    checkForm(req, res, 200, values, []);
  });

  router.post('/checks', (req, res) => {
    const b = req.body;
    const errors = [];
    const amount = number(b.amount, MONEY);
    if (amount.error || !amount.value) errors.push('Enter the amount.');
    const paidOn = date(b.paid_on);
    if (paidOn.error || !paidOn.value) errors.push('Enter the date.');
    const method = choice(b.method, EXPENSE_METHODS);
    if (!method) errors.push('Choose how it was paid.');

    let vendor = null;
    let payeeUser = null;
    let payeeName = null;
    const payeeType = ['vendor', 'staff', 'other'].includes(b.payee_type) ? b.payee_type : 'vendor';
    if (payeeType === 'vendor') {
      vendor = selectVendor.get(Number(b.vendor_id));
      if (!vendor) errors.push('Choose who you are paying (or add them as a vendor).');
      else payeeName = vendor.name;
    } else if (payeeType === 'staff') {
      payeeUser = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(Number(b.payee_user_id));
      if (!payeeUser) errors.push('Choose the staff member.');
      else payeeName = payeeUser.full_name;
    } else {
      payeeName = text(b.payee_name, 120);
      if (!payeeName) errors.push('Enter who the check is made out to.');
    }

    // A deal-linked payment is always a job cost against that deal.
    const dealId = Number(b.deal_id) || null;
    let dealItemId = null;
    let category = choice(b.category, EXPENSE_CATEGORIES);
    if (dealId) {
      const deal = db.prepare("SELECT id FROM deals WHERE id = ? AND status != 'cancelled'").get(dealId);
      if (!deal) errors.push('That deal is not open.');
      category = 'job';
      if (b.deal_item_id && b.deal_item_id !== 'misc') {
        const item = db.prepare('SELECT id FROM deal_items WHERE id = ? AND deal_id = ?').get(Number(b.deal_item_id), dealId);
        if (!item) errors.push('Pick which job on the deal this pays for.');
        else dealItemId = item.id;
      } else if (!b.deal_item_id) {
        errors.push('Pick which job on the deal this pays for (or "Other").');
      }
    } else if (category === 'job') {
      errors.push('Job costs must be linked to a deal. Pick the deal, or choose another category.');
    }
    if (!category) errors.push('Choose a category.');
    if (category === 'commission' && !payeeUser) errors.push('Commission payouts must be made to a staff member.');

    let checkNumber = text(b.check_number, 20);
    if (method === 'check' && checkNumber && db.prepare('SELECT 1 FROM expenses WHERE check_number = ? AND method = ?').get(checkNumber, 'check')) {
      errors.push(`Check #${checkNumber} is already in the register.`);
    }
    if (errors.length) return checkForm(req, res, 400, b, errors);

    const settings = getSettings(db);
    if (method === 'check' && !checkNumber) checkNumber = settings.next_check_number;
    const expenseId = db.transaction(() => {
      const info = insertExpense.run({
        paid_on: paidOn.value,
        amount: round2(amount.value),
        method,
        check_number: method === 'check' ? checkNumber : text(b.check_number, 20),
        vendor_id: vendor ? vendor.id : null,
        payee_user_id: payeeUser ? payeeUser.id : null,
        payee_name: payeeName,
        category,
        memo: text(b.memo, 300),
        deal_id: dealId,
        deal_item_id: dealItemId,
        inventory_id: Number(b.inventory_id) || null,
        created_by: req.user.id,
      });
      const id = Number(info.lastInsertRowid);
      if (method === 'check' && /^\d+$/.test(checkNumber) && Number(checkNumber) >= Number(settings.next_check_number)) {
        setSetting.run('next_check_number', String(Number(checkNumber) + 1));
      }
      if (category === 'commission') {
        books.insertEntry(db, {
          user_id: payeeUser.id,
          kind: 'payout',
          amount: -round2(amount.value),
          expense_id: id,
          note: `Paid ${method === 'check' ? `by check #${checkNumber}` : `by ${EXPENSE_METHODS[method].toLowerCase()}`}`,
          created_by: req.user.id,
        });
      }
      if (dealId) {
        const deal = db.prepare('SELECT customer_id, inventory_id FROM deals WHERE id = ?').get(dealId);
        logActivity(db, {
          userId: req.user.id,
          customerId: deal.customer_id,
          inventoryId: deal.inventory_id,
          dealId,
          message: `Paid ${usd(amount.value)} to ${payeeName}${checkNumber && method === 'check' ? ` (check #${checkNumber})` : ''}`,
        });
        books.syncDealCommission(db, dealId, req.user.id);
      } else {
        logActivity(db, { userId: req.user.id, message: `Paid ${usd(amount.value)} to ${payeeName} (${EXPENSE_CATEGORIES[category]})` });
      }
      return id;
    })();

    let message = `${usd(amount.value)} to ${payeeName} recorded.`;
    if (dealId) {
      const fin = books.dealFinancials(db, dealId);
      const line = fin.jobs.lines.find((l) => (dealItemId ? l.item && l.item.id === dealItemId : l.key === 'misc'));
      if (line && line.over > 0) {
        message += ` ${line.label} is now ${usd(line.over)} over its allotment.`;
        if (fin.commission) message += ` ${fin.commission.rate}% of the overrun comes off the salesperson's commission.`;
        req.flash('error', message, { href: `/books/checks/${expenseId}/print`, label: 'Print check' });
        return res.redirect(`/books/checks/${expenseId}`);
      }
    }
    req.flash('success', message, { href: `/books/checks/${expenseId}/print`, label: 'Print check' });
    res.redirect(`/books/checks/${expenseId}`);
  });

  function loadExpense(req, res, next) {
    const e = selectExpense.get(Number(req.params.id));
    if (!e) return res.status(404).render('error', { title: 'Not found', message: 'That payment does not exist.' });
    req.expense = e;
    next();
  }

  router.get('/checks/:id', loadExpense, (req, res) => {
    const e = req.expense;
    res.render('books/check', {
      title: e.method === 'check' ? `Check #${e.check_number}` : `Payment #${e.id}`,
      e,
      financials: e.deal_id ? books.dealFinancials(db, e.deal_id) : null,
    });
  });

  router.get('/checks/:id/print', loadExpense, (req, res) => {
    res.render('books/check-print', { title: `Check #${req.expense.check_number || req.expense.id}`, e: req.expense, words: books.amountInWords(req.expense.amount) });
  });

  router.post('/checks/:id/void', loadExpense, (req, res) => {
    const e = req.expense;
    const reason = text(req.body.reason, 300);
    if (!reason || e.voided_at) {
      req.flash('error', e.voided_at ? 'Already voided.' : 'Give a reason for voiding.');
      return res.redirect(`/books/checks/${e.id}`);
    }
    db.transaction(() => {
      db.prepare("UPDATE expenses SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?").run(req.user.id, reason, e.id);
      const payout = db.prepare("SELECT * FROM commission_entries WHERE expense_id = ? AND kind = 'payout'").get(e.id);
      if (payout) {
        books.insertEntry(db, {
          user_id: payout.user_id,
          kind: 'adjustment',
          amount: -payout.amount,
          expense_id: e.id,
          note: `Payout ${e.check_number ? `check #${e.check_number}` : `#${e.id}`} voided: ${reason}`,
          created_by: req.user.id,
        });
      }
      if (e.deal_id) books.syncDealCommission(db, e.deal_id, req.user.id);
      logActivity(db, {
        userId: req.user.id,
        dealId: e.deal_id,
        message: `Voided ${usd(e.amount)} payment to ${e.payee_name}: ${reason}`,
      });
    })();
    req.flash('success', 'Payment voided.');
    res.redirect(`/books/checks/${e.id}`);
  });

  // --- Vendors ------------------------------------------------------------------

  function parseVendor(body) {
    return {
      name: text(body.name, 120),
      trade: text(body.trade, 80),
      contact: text(body.contact, 120),
      phone: text(body.phone, 30),
      email: text(body.email, 120),
      address: text(body.address, 300),
      notes: text(body.notes, 2000),
      active: body.active === '0' ? 0 : 1,
    };
  }

  router.get('/vendors', (req, res) => {
    const vendors = db
      .prepare(`
        SELECT v.*, COUNT(e.id) AS payments, COALESCE(SUM(e.amount), 0) AS total, MAX(e.paid_on) AS last_paid
        FROM vendors v LEFT JOIN expenses e ON e.vendor_id = v.id AND e.voided_at IS NULL
        GROUP BY v.id ORDER BY v.active DESC, v.name
      `)
      .all();
    res.render('books/vendors', { title: 'Vendors', vendors });
  });

  router.get('/vendors/new', (req, res) => {
    res.render('books/vendor-form', { title: 'New vendor', vendor: { active: 1 }, error: null, back: req.query.back === 'check' ? 'check' : '' });
  });

  router.post('/vendors', (req, res) => {
    const v = parseVendor(req.body);
    if (!v.name) return res.status(400).render('books/vendor-form', { title: 'New vendor', vendor: v, error: 'Name is required.' });
    const info = db
      .prepare('INSERT INTO vendors (name, trade, contact, phone, email, address, notes, active) VALUES (@name, @trade, @contact, @phone, @email, @address, @notes, @active)')
      .run(v);
    req.flash('success', `${v.name} added.`);
    res.redirect(req.body.back === 'check' ? `/books/checks/new?vendor_id=${info.lastInsertRowid}` : '/books/vendors');
  });

  router.get('/vendors/:id', (req, res) => {
    const vendor = selectVendor.get(Number(req.params.id));
    if (!vendor) return res.status(404).render('error', { title: 'Not found', message: 'That vendor does not exist.' });
    const payments = db
      .prepare(`
        SELECT e.*, di.description AS item_description, c.last_name, i.stock_number FROM expenses e
        LEFT JOIN deal_items di ON di.id = e.deal_item_id LEFT JOIN deals d ON d.id = e.deal_id
        LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN inventory i ON i.id = COALESCE(e.inventory_id, d.inventory_id)
        WHERE e.vendor_id = ? ORDER BY e.paid_on DESC, e.id DESC
      `)
      .all(vendor.id);
    res.render('books/vendor', { title: vendor.name, vendor, payments });
  });

  router.get('/vendors/:id/edit', (req, res) => {
    const vendor = selectVendor.get(Number(req.params.id));
    if (!vendor) return res.status(404).render('error', { title: 'Not found', message: 'That vendor does not exist.' });
    res.render('books/vendor-form', { title: 'Edit vendor', vendor, error: null });
  });

  router.post('/vendors/:id', (req, res) => {
    const existing = selectVendor.get(Number(req.params.id));
    if (!existing) return res.redirect('/books/vendors');
    const v = parseVendor(req.body);
    if (!v.name) return res.status(400).render('books/vendor-form', { title: 'Edit vendor', vendor: { ...v, id: existing.id }, error: 'Name is required.' });
    db.prepare(`
      UPDATE vendors SET name = @name, trade = @trade, contact = @contact, phone = @phone, email = @email,
        address = @address, notes = @notes, active = @active WHERE id = @id
    `).run({ ...v, id: existing.id });
    req.flash('success', 'Vendor updated.');
    res.redirect(`/books/vendors/${existing.id}`);
  });

  // --- Job tracking across all deals ---------------------------------------------

  router.get('/jobs', (req, res) => {
    const status = ['pending', 'sold', 'open', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const filter = { open: "d.status != 'cancelled'", pending: "d.status = 'pending'", sold: "d.status = 'sold'", all: '1 = 1' }[status];
    const ids = db.prepare(`SELECT d.id FROM deals d WHERE ${filter} ORDER BY d.id DESC`).all().map((r) => r.id);
    const deals = ids.map((id) => books.dealFinancials(db, id));
    const onlyOver = req.query.over === '1';
    res.render('books/jobs', {
      title: 'Job costs by deal',
      deals: onlyOver ? deals.filter((f) => f.jobs.overrun > 0) : deals,
      status,
      onlyOver,
    });
  });

  // --- Commission ledgers -------------------------------------------------------

  router.get('/commissions', (req, res) => {
    books.syncGmCommissions(db, req.user.id);
    res.render('books/commissions', { title: 'Commissions', balances: books.ledgerBalances(db), COMMISSION_PLANS });
  });

  router.get('/commissions/:userId', (req, res) => {
    books.syncGmCommissions(db, req.user.id);
    const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!person) return res.status(404).render('error', { title: 'Not found', message: 'That person does not exist.' });
    res.render('books/ledger', {
      title: `${person.full_name} — commission`,
      person,
      rate: books.userRate(db, person),
      entries: ledgerEntries(person.id),
      COMMISSION_PLANS,
      canManage: true,
    });
  });

  router.post('/commissions/:userId/adjust', (req, res) => {
    const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    const amount = number(req.body.amount, { min: -MONEY.max, max: MONEY.max });
    const note = text(req.body.note, 300);
    if (!person || amount.error || !amount.value || !note) {
      req.flash('error', 'Enter an amount (use a minus sign to deduct) and a reason.');
      return res.redirect(`/books/commissions/${req.params.userId}`);
    }
    books.insertEntry(db, { user_id: person.id, kind: 'adjustment', amount: round2(amount.value), note, created_by: req.user.id });
    logActivity(db, { userId: req.user.id, message: `Commission adjustment for ${person.full_name}: ${usd(amount.value)} (${note})` });
    req.flash('success', 'Adjustment recorded.');
    res.redirect(`/books/commissions/${person.id}`);
  });

  // --- Profit & loss -----------------------------------------------------------

  router.get('/profit', (req, res) => {
    books.syncGmCommissions(db, req.user.id);
    const current = today().slice(0, 7);
    let first = current;
    for (let i = 0; i < 11; i++) first = books.previousMonth(first);
    const months = books.monthsBetween(first, current).reverse().map((p) => books.monthProfit(db, p));
    const selected = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : current;
    const detail = months.find((m) => m.period === selected) || books.monthProfit(db, selected);
    const gms = db.prepare("SELECT * FROM users WHERE commission_plan = 'gm'").all().map((u) => ({ ...u, rate: books.userRate(db, u) }));
    res.render('books/profit', { title: 'Profit & loss', months, detail, gms, current });
  });

  function ledgerEntries(userId) {
    const rows = db
      .prepare(`
        SELECT e.*, u.full_name AS created_by_name, c.last_name, i.stock_number, x.check_number, x.paid_on, x.paid_on
        FROM commission_entries e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN deals d ON d.id = e.deal_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN inventory i ON i.id = d.inventory_id
        LEFT JOIN expenses x ON x.id = e.expense_id
        WHERE e.user_id = ? ORDER BY e.created_at, e.id
      `)
      .all(userId);
    let running = 0;
    for (const r of rows) {
      running = round2(running + r.amount);
      r.balance = running;
    }
    return rows.reverse();
  }

  return router;
};

// Anyone can see their own commission ledger (no gross-profit figures on it).
module.exports.myCommissions = function myCommissionRoutes(db) {
  const router = express.Router();
  router.get('/', (req, res) => {
    books.syncGmCommissions(db, null);
    const rows = db
      .prepare(`
        SELECT e.*, c.last_name, i.stock_number, x.check_number, x.paid_on FROM commission_entries e
        LEFT JOIN deals d ON d.id = e.deal_id LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN inventory i ON i.id = d.inventory_id LEFT JOIN expenses x ON x.id = e.expense_id
        WHERE e.user_id = ? ORDER BY e.created_at, e.id
      `)
      .all(req.user.id);
    let running = 0;
    for (const r of rows) {
      running = round2(running + r.amount);
      r.balance = running;
      // Hide the gross/net profit figures embedded in system notes from non-managers.
      if (req.user.role !== 'manager' && r.kind !== 'adjustment') r.note = describeEntry(r);
    }
    const person = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.render('books/ledger', {
      title: 'My commission',
      person,
      rate: books.userRate(db, person),
      entries: rows.reverse(),
      COMMISSION_PLANS,
      canManage: false,
    });
  });
  return router;
};

function describeEntry(r) {
  const deal = r.deal_id ? `Deal #${r.deal_id}${r.last_name ? ` (${r.last_name}, #${r.stock_number})` : ''}` : '';
  switch (r.kind) {
    case 'earned':
      return r.amount >= 0 ? `${deal} commission` : `${deal} commission reduced`;
    case 'overrun':
      return r.amount <= 0 ? `${deal} job costs over allotment` : `${deal} job cost charge-back reversed`;
    case 'gm':
      return `${books.monthLabel(r.period)} net profit share`;
    case 'payout':
      return r.check_number ? `Paid — check #${r.check_number}` : 'Paid';
    default:
      return r.note;
  }
}
