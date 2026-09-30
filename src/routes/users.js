const express = require('express');
const { requireRole, hashPassword, passwordProblem } = require('../auth');
const { ROLES } = require('../db');
const { text } = require('../format');

// Staff accounts: managers only.
module.exports = function userRoutes(db) {
  const router = express.Router();
  router.use(requireRole('manager'));

  const listUsers = db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY active DESC, full_name');
  const selectUser = db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?');
  const usernameTaken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?');
  const insertUser = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)');
  const updateUser = db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?');
  const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const dropSessions = db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?");

  function loadUserRecord(req, res, next) {
    const record = selectUser.get(Number(req.params.id));
    if (!record) return res.status(404).render('error', { title: 'Not found', message: 'That user does not exist.' });
    req.record = record;
    next();
  }

  router.get('/', (req, res) => {
    res.render('users/index', { title: 'Staff accounts', users: listUsers.all() });
  });

  router.get('/new', (req, res) => {
    res.render('users/new', { title: 'New staff account', values: { role: 'sales' }, error: null });
  });

  router.post('/', (req, res) => {
    const values = {
      full_name: text(req.body.full_name, 100),
      username: text(req.body.username, 60),
      role: req.body.role,
    };
    let error = null;
    if (!values.full_name || !values.username) error = 'Name and username are required.';
    else if (!/^[A-Za-z0-9._-]{3,60}$/.test(values.username)) {
      error = 'Username must be at least 3 characters: letters, numbers, dot, dash or underscore.';
    } else if (!ROLES[values.role]) error = 'Choose an access level.';
    else if (usernameTaken.get(values.username, 0)) error = 'That username is already taken.';
    else error = passwordProblem(req.body.password, req.body.confirm);
    if (error) return res.status(400).render('users/new', { title: 'New staff account', values, error });

    insertUser.run(values.username, values.full_name, hashPassword(req.body.password), values.role);
    req.session.flash = { type: 'success', message: `Account created for ${values.full_name}.` };
    res.redirect('/users');
  });

  router.get('/:id/edit', loadUserRecord, (req, res) => {
    res.render('users/edit', { title: 'Edit staff account', record: req.record, error: null });
  });

  router.post('/:id', loadUserRecord, (req, res) => {
    const isSelf = req.record.id === req.user.id;
    const record = {
      ...req.record,
      full_name: text(req.body.full_name, 100),
      role: req.body.role,
      active: req.body.active === '1' ? 1 : 0,
    };
    let error = null;
    if (!record.full_name) error = 'Name is required.';
    else if (!ROLES[record.role]) error = 'Choose an access level.';
    else if (isSelf && (record.role !== 'manager' || !record.active)) {
      error = 'You cannot remove your own manager access or deactivate yourself.';
    } else if (req.body.password) error = passwordProblem(req.body.password, req.body.confirm);
    if (error) return res.status(400).render('users/edit', { title: 'Edit staff account', record, error });

    db.transaction(() => {
      updateUser.run(record.full_name, record.role, record.active, record.id);
      if (req.body.password) updatePassword.run(hashPassword(req.body.password), record.id);
      // Force re-login when someone loses access or has their password reset.
      if (!isSelf && (!record.active || req.body.password)) dropSessions.run(record.id);
    })();

    req.session.flash = { type: 'success', message: `${record.full_name}’s account updated.` };
    res.redirect('/users');
  });

  return router;
};
