const express = require('express');
const { NOTE_KINDS } = require('../db');
const { text, choice } = require('../format');

// Notes attach to a customer, a home, or a deal (a deal note is also filed on
// that deal's customer so it shows in their history).
module.exports = function noteRoutes(db) {
  const router = express.Router();

  const insertNote = db.prepare(
    'INSERT INTO notes (customer_id, inventory_id, deal_id, user_id, kind, body) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const customerExists = db.prepare('SELECT id FROM customers WHERE id = ?');
  const homeExists = db.prepare('SELECT id FROM inventory WHERE id = ?');
  const dealLookup = db.prepare('SELECT id, customer_id, inventory_id FROM deals WHERE id = ?');
  const selectNote = db.prepare('SELECT * FROM notes WHERE id = ?');
  const deleteNote = db.prepare('DELETE FROM notes WHERE id = ?');
  const touchCustomer = db.prepare("UPDATE customers SET updated_at = datetime('now') WHERE id = ?");

  function backUrl(note) {
    if (note.deal_id) return `/deals/${note.deal_id}#notes`;
    if (note.customer_id) return `/customers/${note.customer_id}#timeline`;
    if (note.inventory_id) return `/inventory/${note.inventory_id}#notes`;
    return '/';
  }

  router.post('/', (req, res) => {
    const body = text(req.body.body, 4000);
    const kind = choice(req.body.kind, NOTE_KINDS) || 'note';
    let customerId = null;
    let inventoryId = null;
    let dealId = null;

    if (req.body.deal_id) {
      const deal = dealLookup.get(Number(req.body.deal_id));
      if (deal) [dealId, customerId, inventoryId] = [deal.id, deal.customer_id, deal.inventory_id];
    } else if (req.body.customer_id) {
      const c = customerExists.get(Number(req.body.customer_id));
      if (c) customerId = c.id;
    } else if (req.body.inventory_id) {
      const h = homeExists.get(Number(req.body.inventory_id));
      if (h) inventoryId = h.id;
    }

    const note = { deal_id: dealId, customer_id: customerId, inventory_id: inventoryId };
    if (!dealId && !customerId && !inventoryId) {
      return res.status(400).render('error', { title: 'Note not saved', message: 'That record no longer exists.' });
    }
    if (!body) {
      req.flash('error', 'Write something before saving the note.');
      return res.redirect(backUrl(note));
    }
    insertNote.run(customerId, inventoryId, dealId, req.user.id, kind, body);
    if (customerId) touchCustomer.run(customerId);
    res.redirect(backUrl(note));
  });

  // Authors can remove their own notes; managers can remove any.
  router.post('/:id/delete', (req, res) => {
    const note = selectNote.get(Number(req.params.id));
    if (!note) return res.redirect('/');
    if (note.user_id !== req.user.id && req.user.role !== 'manager') {
      return res.status(403).render('error', { title: 'Access denied', message: 'You can only delete your own notes.' });
    }
    deleteNote.run(note.id);
    req.flash('success', 'Note deleted.');
    res.redirect(backUrl(note));
  });

  return router;
};
