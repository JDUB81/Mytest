const express = require('express');
const { hashPassword, verifyPassword, passwordProblem, requireLogin } = require('../auth');
const { text } = require('../format');

// Lock out an IP/username pair for 15 minutes after 5 failed logins.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

module.exports = function authRoutes(db) {
  const router = express.Router();
  const failures = new Map();

  const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
  const findByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
  const findById = db.prepare('SELECT * FROM users WHERE id = ?');
  const insertUser = db.prepare(
    'INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

  const needsSetup = () => countUsers.get().n === 0;

  function startSession(req, res, userId) {
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = userId;
      res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
    });
  }

  router.get('/login', (req, res) => {
    if (needsSetup()) return res.redirect('/setup');
    if (req.user) return res.redirect('/');
    res.render('login', { title: 'Sign in', error: null, username: '' });
  });

  router.post('/login', (req, res) => {
    const username = text(req.body.username, 60) || '';
    const password = String(req.body.password || '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    const record = failures.get(key);

    if (record && record.count >= MAX_FAILURES && Date.now() - record.last < LOCKOUT_MS) {
      return res.status(429).render('login', {
        title: 'Sign in',
        error: 'Too many failed attempts. Please wait 15 minutes and try again.',
        username,
      });
    }

    const user = username ? findByUsername.get(username) : null;
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      const count = record && Date.now() - record.last < LOCKOUT_MS ? record.count + 1 : 1;
      failures.set(key, { count, last: Date.now() });
      return res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.', username });
    }

    failures.delete(key);
    startSession(req, res, user.id);
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('premier.sid');
      res.redirect('/login');
    });
  });

  // First-run setup: only reachable while no accounts exist. Creates the first manager.
  router.get('/setup', (req, res) => {
    if (!needsSetup()) return res.redirect('/login');
    res.render('setup', { title: 'Set up Premier Homes CRM', error: null, values: {} });
  });

  router.post('/setup', (req, res) => {
    if (!needsSetup()) return res.redirect('/login');
    const values = { full_name: text(req.body.full_name, 100), username: text(req.body.username, 60) };
    let error = null;
    if (!values.full_name || !values.username) error = 'Name and username are required.';
    else error = passwordProblem(req.body.password, req.body.confirm);
    if (error) return res.status(400).render('setup', { title: 'Set up Premier Homes CRM', error, values });

    const info = insertUser.run(values.username, values.full_name, hashPassword(req.body.password), 'manager');
    req.session.flash = { type: 'success', message: 'Manager account created. Welcome to Premier Homes CRM!' };
    startSession(req, res, info.lastInsertRowid);
  });

  router.get('/account/password', requireLogin, (req, res) => {
    res.render('password', { title: 'Change password', error: null });
  });

  router.post('/account/password', requireLogin, (req, res) => {
    const user = findById.get(req.user.id);
    let error = null;
    if (!verifyPassword(String(req.body.current || ''), user.password_hash)) {
      error = 'Current password is incorrect.';
    } else {
      error = passwordProblem(req.body.password, req.body.confirm);
    }
    if (error) return res.status(400).render('password', { title: 'Change password', error });

    updatePassword.run(hashPassword(req.body.password), user.id);
    req.session.flash = { type: 'success', message: 'Your password has been changed.' };
    res.redirect('/');
  });

  return router;
};
