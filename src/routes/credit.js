const express = require('express');
const { APPLICATION_STATUSES, DOCUMENT_TYPES } = require('../db');
const { text, number, date, choice } = require('../format');
const { logActivity, today } = require('../deals');
const { encrypt, normalizeSsn, maskSsn } = require('../secure');
const credit = require('../credit');

const MONEY = { max: 100000000 };

// Credit application, lender submissions and document checklist for a customer.
// Mounted under /customers; open to every signed-in staff member.
module.exports = function creditRoutes(db) {
  const router = express.Router();

  const selectCustomer = db.prepare('SELECT * FROM customers WHERE id = ?');

  function loadCustomer(req, res, next) {
    const customer = selectCustomer.get(Number(req.params.id));
    if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'That customer does not exist.' });
    req.customer = customer;
    next();
  }

  // Parse every form field according to its type. Unknown/blank values are dropped.
  function parseApp(body) {
    const data = {};
    const errors = [];
    const fields = [
      ...credit.inputFields(credit.PERSON_FIELDS).flatMap((f) => [{ ...f, key: `a_${f.key}` }, { ...f, key: `c_${f.key}`, co: true }]),
      ...credit.inputFields(credit.PURCHASE_FIELDS),
    ];
    for (const f of fields) {
      const raw = body[f.key];
      if (f.type === 'money' || f.type === 'number') {
        const parsed = number(raw, MONEY);
        if (parsed.error) errors.push(`${f.co ? 'Co-applicant ' : ''}${f.label} must be a number.`);
        else if (parsed.value !== null) data[f.key] = parsed.value;
      } else if (f.type === 'date') {
        const parsed = date(raw);
        if (parsed.error) errors.push(`${f.co ? 'Co-applicant ' : ''}${f.label} is not a valid date.`);
        else if (parsed.value) data[f.key] = parsed.value;
      } else if (f.type === 'select') {
        const v = choice(raw, f.options);
        if (v) data[f.key] = v;
      } else {
        const v = text(raw, 300);
        if (v) data[f.key] = v;
      }
    }
    data.has_co = body.has_co === '1';
    return { data, errors };
  }

  function renderForm(req, res, status, data, errors) {
    const app = credit.loadApp(db, req.customer.id);
    res.status(status).render('credit/form', {
      title: `Credit application — ${req.customer.first_name} ${req.customer.last_name}`,
      customer: req.customer,
      data,
      errors,
      ssnMask: app ? maskSsn(app.ssn) : '',
      coSsnMask: app ? maskSsn(app.co_ssn) : '',
      PERSON_FIELDS: credit.PERSON_FIELDS,
      PURCHASE_FIELDS: credit.PURCHASE_FIELDS,
    });
  }

  router.get('/:id/credit', loadCustomer, (req, res) => {
    const app = credit.loadApp(db, req.customer.id);
    const data = app ? app.data : credit.prefill(db, req.customer);
    if (!app && data.c_first_name) data.has_co = true;
    renderForm(req, res, 200, data, []);
  });

  router.post('/:id/credit', loadCustomer, (req, res) => {
    const { data, errors } = parseApp(req.body);
    const ssnRaw = text(req.body.ssn, 20);
    const coSsnRaw = text(req.body.co_ssn, 20);
    const ssn = ssnRaw ? normalizeSsn(ssnRaw) : null;
    const coSsn = coSsnRaw ? normalizeSsn(coSsnRaw) : null;
    if (ssnRaw && !ssn) errors.push('Social Security number must be 9 digits.');
    if (coSsnRaw && !coSsn) errors.push('Co-applicant Social Security number must be 9 digits.');
    if (errors.length) return renderForm(req, res, 400, data, errors);

    const existing = db.prepare('SELECT id FROM credit_apps WHERE customer_id = ?').get(req.customer.id);
    db.transaction(() => {
      if (!existing) {
        db.prepare('INSERT INTO credit_apps (customer_id, data, updated_by) VALUES (?, ?, ?)').run(req.customer.id, JSON.stringify(data), req.user.id);
      } else {
        db.prepare("UPDATE credit_apps SET data = ?, updated_by = ?, updated_at = datetime('now') WHERE customer_id = ?").run(
          JSON.stringify(data), req.user.id, req.customer.id
        );
      }
      // Blank SSN boxes keep what's on file; "remove" clears it.
      if (ssn) db.prepare('UPDATE credit_apps SET ssn_enc = ? WHERE customer_id = ?').run(encrypt(db, ssn), req.customer.id);
      if (coSsn) db.prepare('UPDATE credit_apps SET co_ssn_enc = ? WHERE customer_id = ?').run(encrypt(db, coSsn), req.customer.id);
      if (!data.has_co || req.body.clear_co_ssn === '1') db.prepare('UPDATE credit_apps SET co_ssn_enc = NULL WHERE customer_id = ?').run(req.customer.id);
      if (req.body.clear_ssn === '1') db.prepare('UPDATE credit_apps SET ssn_enc = NULL WHERE customer_id = ?').run(req.customer.id);
      logActivity(db, { userId: req.user.id, customerId: req.customer.id, message: existing ? 'Updated credit application' : 'Started credit application' });
    })();
    req.flash('success', 'Credit application saved.', { href: `/customers/${req.customer.id}/credit/print`, label: 'Print application' });
    res.redirect(`/customers/${req.customer.id}#credit`);
  });

  router.get('/:id/credit/print', loadCustomer, (req, res) => {
    const app = credit.loadApp(db, req.customer.id);
    if (!app) {
      req.flash('error', 'Fill in the credit application first.');
      return res.redirect(`/customers/${req.customer.id}/credit`);
    }
    logActivity(db, { userId: req.user.id, customerId: req.customer.id, message: 'Printed credit application' });
    res.render('credit/print', {
      title: `Credit application — ${req.customer.first_name} ${req.customer.last_name}`,
      customer: req.customer,
      app,
      blank: req.query.blank_ssn === '1',
      PERSON_FIELDS: credit.PERSON_FIELDS,
      PURCHASE_FIELDS: credit.PURCHASE_FIELDS,
    });
  });

  // --- Lender submissions ---------------------------------------------------

  function parseSubmission(body) {
    const errors = [];
    const money = (k, label) => {
      const p = number(body[k], MONEY);
      if (p.error) errors.push(`${label} must be a number.`);
      return p.value ?? null;
    };
    const values = {
      lender: text(body.lender, 120),
      submitted_on: date(body.submitted_on).value || today(),
      status: choice(body.status, APPLICATION_STATUSES) || 'submitted',
      amount_requested: money('amount_requested', 'Amount requested'),
      amount_approved: money('amount_approved', 'Amount approved'),
      rate: (() => {
        const p = number(body.rate, { max: 40 });
        if (p.error) errors.push('Rate must be a percentage.');
        return p.value ?? null;
      })(),
      term_months: (() => {
        const p = number(body.term_months, { integer: true, max: 480 });
        if (p.error) errors.push('Term must be a whole number of months.');
        return p.value ?? null;
      })(),
      payment: money('payment', 'Payment'),
      conditions: text(body.conditions, 1000),
      notes: text(body.notes, 1000),
    };
    if (!values.lender) errors.push('Enter the lender.');
    return { values, errors };
  }

  router.post('/:id/submissions', loadCustomer, (req, res) => {
    const { values, errors } = parseSubmission(req.body);
    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect(`/customers/${req.customer.id}#lenders`);
    }
    const deal = db.prepare("SELECT id FROM deals WHERE customer_id = ? AND status != 'cancelled' ORDER BY id DESC").get(req.customer.id);
    db.prepare(`
      INSERT INTO lender_submissions (customer_id, deal_id, lender, submitted_on, status, amount_requested, amount_approved,
        rate, term_months, payment, conditions, notes, created_by)
      VALUES (@customer_id, @deal_id, @lender, @submitted_on, @status, @amount_requested, @amount_approved,
        @rate, @term_months, @payment, @conditions, @notes, @created_by)
    `).run({ ...values, customer_id: req.customer.id, deal_id: deal ? deal.id : null, created_by: req.user.id });
    if (['submitted', 'pending'].includes(values.status) && ['new', 'contacted', 'appointment'].includes(req.customer.lead_status)) {
      db.prepare("UPDATE customers SET lead_status = 'application', updated_at = datetime('now') WHERE id = ?").run(req.customer.id);
    }
    logActivity(db, { userId: req.user.id, customerId: req.customer.id, message: `Credit app sent to ${values.lender} (${APPLICATION_STATUSES[values.status]})` });
    req.flash('success', `Submission to ${values.lender} recorded.`);
    res.redirect(`/customers/${req.customer.id}#lenders`);
  });

  router.post('/:id/submissions/:sid', loadCustomer, (req, res) => {
    const existing = db.prepare('SELECT * FROM lender_submissions WHERE id = ? AND customer_id = ?').get(Number(req.params.sid), req.customer.id);
    if (!existing) return res.redirect(`/customers/${req.customer.id}#lenders`);
    const { values, errors } = parseSubmission({ ...existing, ...req.body, lender: req.body.lender || existing.lender });
    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect(`/customers/${req.customer.id}#lenders`);
    }
    db.prepare(`
      UPDATE lender_submissions SET status = @status, amount_requested = @amount_requested, amount_approved = @amount_approved,
        rate = @rate, term_months = @term_months, payment = @payment, conditions = @conditions, notes = @notes,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({ ...values, id: existing.id });
    if (values.status !== existing.status) {
      if (values.status === 'approved' && !['under_contract', 'closed'].includes(req.customer.lead_status)) {
        db.prepare("UPDATE customers SET lead_status = 'approved', updated_at = datetime('now') WHERE id = ?").run(req.customer.id);
      }
      logActivity(db, {
        userId: req.user.id,
        customerId: req.customer.id,
        message: `${existing.lender}: ${APPLICATION_STATUSES[existing.status]} → ${APPLICATION_STATUSES[values.status]}${values.amount_approved ? ` (approved ${values.amount_approved.toLocaleString('en-US', { style: 'currency', currency: 'USD' })})` : ''}`,
      });
    }
    req.flash('success', 'Lender submission updated.');
    res.redirect(`/customers/${req.customer.id}#lenders`);
  });

  // --- Document checklist -----------------------------------------------------

  router.post('/:id/documents', loadCustomer, (req, res) => {
    const wanted = new Set([].concat(req.body.docs || []).filter((d) => DOCUMENT_TYPES[d]));
    const have = new Set(db.prepare('SELECT doc_type FROM customer_documents WHERE customer_id = ?').all(req.customer.id).map((r) => r.doc_type));
    const added = [...wanted].filter((d) => !have.has(d));
    const removed = [...have].filter((d) => !wanted.has(d));
    db.transaction(() => {
      for (const d of added) {
        db.prepare('INSERT INTO customer_documents (customer_id, doc_type, received_on, received_by) VALUES (?, ?, ?, ?)').run(req.customer.id, d, today(), req.user.id);
      }
      for (const d of removed) db.prepare('DELETE FROM customer_documents WHERE customer_id = ? AND doc_type = ?').run(req.customer.id, d);
      if (added.length || removed.length) {
        const parts = [];
        if (added.length) parts.push(`received ${added.map((d) => DOCUMENT_TYPES[d]).join(', ')}`);
        if (removed.length) parts.push(`unchecked ${removed.map((d) => DOCUMENT_TYPES[d]).join(', ')}`);
        logActivity(db, { userId: req.user.id, customerId: req.customer.id, message: `Documents: ${parts.join('; ')}` });
      }
    })();
    req.flash('success', 'Document checklist updated.');
    res.redirect(`/customers/${req.customer.id}#documents`);
  });

  return router;
};
