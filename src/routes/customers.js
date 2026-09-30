const express = require('express');
const { requireRole } = require('../auth');
const { LEAD_STATUSES, LEAD_SOURCES, LAND_STATUSES, FINANCING_TYPES } = require('../db');
const { text, number, date, choice } = require('../format');
const { logActivity, today } = require('../deals');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_METHODS = ['Phone call', 'Text', 'Email'];

function parseCustomer(body, validSalespeople) {
  const values = {
    first_name: text(body.first_name, 60),
    last_name: text(body.last_name, 60),
    phone: text(body.phone, 30),
    email: text(body.email, 120),
    address: text(body.address, 200),
    city: text(body.city, 80),
    state: text(body.state, 40),
    zip: text(body.zip, 15),
    notes: text(body.notes, 4000),
    lead_status: choice(body.lead_status, LEAD_STATUSES) || 'new',
    lead_source: choice(body.lead_source, LEAD_SOURCES),
    land_status: choice(body.land_status, LAND_STATUSES),
    land_location: text(body.land_location, 200),
    financing_pref: choice(body.financing_pref, FINANCING_TYPES),
    preferred_contact: choice(body.preferred_contact, CONTACT_METHODS),
    co_buyer_name: text(body.co_buyer_name, 120),
    co_buyer_phone: text(body.co_buyer_phone, 30),
    co_buyer_email: text(body.co_buyer_email, 120),
    salesperson_id: validSalespeople.includes(Number(body.salesperson_id)) ? Number(body.salesperson_id) : null,
  };
  const errors = [];
  if (!values.first_name) errors.push('First name is required.');
  if (!values.last_name) errors.push('Last name is required.');
  if (!values.phone && !values.email) errors.push('Enter a phone number or email so we can reach the customer.');
  if (values.email && !EMAIL_RE.test(values.email)) errors.push('Email address looks invalid.');
  if (values.co_buyer_email && !EMAIL_RE.test(values.co_buyer_email)) errors.push('Co-buyer email looks invalid.');

  const budget = number(body.budget, { max: 100000000 });
  if (budget.error) errors.push('Budget must be a valid amount.');
  values.budget = budget.error ? body.budget : budget.value;
  const beds = number(body.desired_bedrooms, { integer: true, max: 20 });
  if (beds.error) errors.push('Bedrooms wanted must be a whole number.');
  values.desired_bedrooms = beds.error ? body.desired_bedrooms : beds.value;
  const followUp = date(body.follow_up_date);
  if (followUp.error) errors.push('Follow-up date is invalid.');
  values.follow_up_date = followUp.error ? null : followUp.value;
  return { values, errors };
}

const FIELDS = [
  'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'notes', 'lead_status',
  'lead_source', 'land_status', 'land_location', 'financing_pref', 'preferred_contact', 'co_buyer_name',
  'co_buyer_phone', 'co_buyer_email', 'salesperson_id', 'budget', 'desired_bedrooms', 'follow_up_date',
];

module.exports = function customerRoutes(db) {
  const router = express.Router();

  const selectCustomer = db.prepare(`
    SELECT c.*, u.full_name AS created_by_name, s.full_name AS salesperson_name FROM customers c
    LEFT JOIN users u ON u.id = c.created_by
    LEFT JOIN users s ON s.id = c.salesperson_id
    WHERE c.id = ?
  `);
  const insertCustomer = db.prepare(`
    INSERT INTO customers (${FIELDS.join(', ')}, created_by)
    VALUES (${FIELDS.map((f) => '@' + f).join(', ')}, @created_by)
  `);
  const updateCustomer = db.prepare(`
    UPDATE customers SET ${FIELDS.map((f) => `${f} = @${f}`).join(', ')}, updated_at = datetime('now')
    WHERE id = @id
  `);
  const hasHistory = db.prepare(`
    SELECT EXISTS (SELECT 1 FROM deals WHERE customer_id = ?) OR EXISTS (SELECT 1 FROM inventory WHERE customer_id = ?) AS used
  `);
  const deleteCustomer = db.prepare('DELETE FROM customers WHERE id = ?');
  const dealsFor = db.prepare(`
    SELECT d.*, i.stock_number, i.manufacturer, i.model, i.year FROM deals d
    JOIN inventory i ON i.id = d.inventory_id
    WHERE d.customer_id = ? ORDER BY d.created_at DESC, d.id DESC
  `);
  const availableHomes = db.prepare(
    "SELECT id, stock_number, manufacturer, model, year, price, bedrooms FROM inventory WHERE status = 'available' ORDER BY stock_number"
  );
  const notesFor = db.prepare(`
    SELECT n.id, n.kind, n.body, n.created_at, n.user_id, n.deal_id, n.inventory_id, u.full_name AS author
    FROM notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.customer_id = ?
  `);
  const activityFor = db.prepare(`
    SELECT a.id, a.message, a.created_at, a.deal_id, u.full_name AS author
    FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.customer_id = ?
  `);
  const tasksFor = db.prepare(`
    SELECT t.*, u.full_name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.customer_id = ? ORDER BY t.done_at IS NOT NULL, t.due_date IS NULL, t.due_date, t.id
  `);
  const staff = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name');
  const staffIds = () => staff.all().map((u) => u.id);

  function loadCustomer(req, res, next) {
    const customer = selectCustomer.get(Number(req.params.id));
    if (!customer) {
      return res.status(404).render('error', { title: 'Not found', message: 'That customer does not exist.' });
    }
    req.customer = customer;
    next();
  }

  function renderForm(res, status, title, customer, errors) {
    res.status(status).render('customers/form', {
      title,
      customer,
      errors,
      staff: staff.all(),
      CONTACT_METHODS,
    });
  }

  router.get('/', (req, res) => {
    const q = text(req.query.q, 100);
    const stage = choice(req.query.stage, LEAD_STATUSES) || (req.query.stage === 'all' ? 'all' : 'open');
    const owner = req.query.owner === 'me' ? 'me' : req.query.owner === 'none' ? 'none' : 'all';
    const followUp = req.query.follow_up === 'due';

    const where = [];
    const params = {};
    if (q) {
      where.push(`(c.first_name LIKE @q OR c.last_name LIKE @q OR (c.first_name || ' ' || c.last_name) LIKE @q
        OR c.phone LIKE @q OR c.email LIKE @q OR c.co_buyer_name LIKE @q OR c.city LIKE @q)`);
      params.q = `%${q}%`;
    }
    if (stage === 'open') where.push("c.lead_status NOT IN ('closed', 'lost')");
    else if (stage !== 'all') {
      where.push('c.lead_status = @stage');
      params.stage = stage;
    }
    if (owner === 'me') {
      where.push('c.salesperson_id = @me');
      params.me = req.user.id;
    } else if (owner === 'none') where.push('c.salesperson_id IS NULL');
    if (followUp) {
      where.push('c.follow_up_date IS NOT NULL AND c.follow_up_date <= @today');
      params.today = today();
    }

    const customers = db
      .prepare(`
        SELECT c.*, s.full_name AS salesperson_name,
          (SELECT COUNT(*) FROM deals d WHERE d.customer_id = c.id AND d.status != 'cancelled') AS deal_count,
          (SELECT MAX(created_at) FROM notes n WHERE n.customer_id = c.id) AS last_note_at
        FROM customers c LEFT JOIN users s ON s.id = c.salesperson_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${followUp ? 'c.follow_up_date,' : ''} c.last_name, c.first_name
      `)
      .all(params);
    const stageCounts = {};
    for (const row of db.prepare('SELECT lead_status, COUNT(*) n FROM customers GROUP BY lead_status').all()) {
      stageCounts[row.lead_status] = row.n;
    }
    res.render('customers/index', {
      title: 'Customers',
      customers,
      stageCounts,
      filters: { q: q || '', stage, owner, follow_up: followUp ? 'due' : '' },
    });
  });

  router.get('/new', (req, res) => {
    renderForm(res, 200, 'New customer', { salesperson_id: req.user.id, lead_status: 'new' }, []);
  });

  router.post('/', (req, res) => {
    const { values, errors } = parseCustomer(req.body, staffIds());
    if (errors.length) return renderForm(res, 400, 'New customer', values, errors);
    const info = insertCustomer.run({ ...values, created_by: req.user.id });
    logActivity(db, { userId: req.user.id, customerId: info.lastInsertRowid, message: 'Customer record created' });
    req.flash('success', `${values.first_name} ${values.last_name} added.`);
    res.redirect(`/customers/${info.lastInsertRowid}`);
  });

  router.get('/:id', loadCustomer, (req, res) => {
    const c = req.customer;
    // One combined, newest-first timeline of notes and system activity.
    const timeline = [
      ...notesFor.all(c.id).map((n) => ({ ...n, type: 'note' })),
      ...activityFor.all(c.id).map((a) => ({ ...a, type: 'activity' })),
    ].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));

    res.render('customers/show', {
      title: `${c.first_name} ${c.last_name}`,
      customer: c,
      deals: dealsFor.all(c.id),
      availableHomes: availableHomes.all(),
      timeline,
      tasks: tasksFor.all(c.id),
      staff: staff.all(),
    });
  });

  router.get('/:id/edit', loadCustomer, (req, res) => {
    renderForm(res, 200, 'Edit customer', req.customer, []);
  });

  router.post('/:id', loadCustomer, (req, res) => {
    const { values, errors } = parseCustomer(req.body, staffIds());
    if (errors.length) return renderForm(res, 400, 'Edit customer', { ...values, id: req.customer.id }, errors);
    updateCustomer.run({ ...values, id: req.customer.id });
    const old = req.customer;
    const changes = [];
    if (old.lead_status !== values.lead_status) {
      changes.push(`stage ${LEAD_STATUSES[old.lead_status] || old.lead_status} → ${LEAD_STATUSES[values.lead_status]}`);
    }
    if (old.salesperson_id !== values.salesperson_id) {
      const name = staff.all().find((u) => u.id === values.salesperson_id);
      changes.push(`salesperson → ${name ? name.full_name : 'unassigned'}`);
    }
    if (old.follow_up_date !== values.follow_up_date && values.follow_up_date) changes.push(`follow-up set for ${values.follow_up_date}`);
    logActivity(db, {
      userId: req.user.id,
      customerId: old.id,
      message: changes.length ? `Updated customer: ${changes.join(', ')}` : 'Updated customer details',
    });
    req.flash('success', 'Customer updated.');
    res.redirect(`/customers/${req.customer.id}`);
  });

  // Quick actions from the profile page without opening the full edit form.
  router.post('/:id/quick', loadCustomer, (req, res) => {
    const c = req.customer;
    const messages = [];
    if (req.body.lead_status !== undefined) {
      const stage = choice(req.body.lead_status, LEAD_STATUSES);
      if (stage && stage !== c.lead_status) {
        db.prepare("UPDATE customers SET lead_status = ?, updated_at = datetime('now') WHERE id = ?").run(stage, c.id);
        messages.push(`Stage ${LEAD_STATUSES[c.lead_status] || c.lead_status} → ${LEAD_STATUSES[stage]}`);
      }
    }
    if (req.body.follow_up_date !== undefined) {
      const d = date(req.body.follow_up_date);
      if (!d.error && d.value !== c.follow_up_date) {
        db.prepare("UPDATE customers SET follow_up_date = ?, updated_at = datetime('now') WHERE id = ?").run(d.value, c.id);
        messages.push(d.value ? `Follow-up set for ${d.value}` : 'Follow-up cleared');
      }
    }
    if (messages.length) {
      logActivity(db, { userId: req.user.id, customerId: c.id, message: messages.join('; ') });
      req.flash('success', messages.join('. ') + '.');
    }
    res.redirect(`/customers/${c.id}`);
  });

  router.post('/:id/delete', requireRole('manager'), loadCustomer, (req, res) => {
    const id = req.customer.id;
    if (hasHistory.get(id, id).used) {
      req.flash('error', 'This customer has deal history, so they can’t be deleted. Mark them as Lost instead.');
      return res.redirect(`/customers/${id}`);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM activity WHERE customer_id = ?').run(id);
      deleteCustomer.run(id);
      logActivity(db, {
        userId: req.user.id,
        message: `Deleted customer ${req.customer.first_name} ${req.customer.last_name}`,
      });
    })();
    req.flash('success', 'Customer deleted.');
    res.redirect('/customers');
  });

  return router;
};
