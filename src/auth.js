const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function passwordProblem(password, confirm) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (confirm !== undefined && password !== confirm) {
    return 'Passwords do not match.';
  }
  return null;
}

// Loads the logged-in user (if any) onto req.user / res.locals.user and
// exposes helpers every view needs.
function loadUser(db) {
  const findUser = db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?');
  return (req, res, next) => {
    req.user = null;
    if (req.session.userId) {
      const user = findUser.get(req.session.userId);
      if (user && user.active) {
        req.user = user;
      } else {
        delete req.session.userId;
      }
    }
    res.locals.user = req.user;
    res.locals.isManager = !!(req.user && req.user.role === 'manager');
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'Your account does not have permission to do that. Ask a manager if you need access.',
      });
    }
    next();
  };
}

// Per-session CSRF token checked on every state-changing request.
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
    const expected = Buffer.from(req.session.csrfToken);
    const actual = Buffer.from(String(sent));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(403).render('error', {
        title: 'Form expired',
        message: 'Your form session expired. Go back, refresh the page, and try again.',
      });
    }
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  passwordProblem,
  loadUser,
  requireLogin,
  requireRole,
  csrf,
  MIN_PASSWORD_LENGTH,
};
