const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./sessionStore');
const { ROLES } = require('./db');
const { loadUser, requireLogin, csrf } = require('./auth');
const { formatMoney, formatDate, statusLabel } = require('./format');

function createApp(db, options = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (options.trustProxy || process.env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(
    session({
      store: new SqliteStore(db),
      secret: options.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
      name: 'premier.sid',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 12 * 60 * 60 * 1000, // one work day
      },
    })
  );

  app.use(loadUser(db));

  app.use((req, res, next) => {
    res.locals.ROLES = ROLES;
    res.locals.formatMoney = formatMoney;
    res.locals.formatDate = formatDate;
    res.locals.statusLabel = statusLabel;
    res.locals.currentPath = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  app.use(csrf);

  app.use(require('./routes/auth')(db));
  app.use(requireLogin);
  app.use(require('./routes/dashboard')(db));
  app.use('/inventory', require('./routes/inventory')(db));
  app.use('/customers', require('./routes/customers')(db));
  app.use('/users', require('./routes/users')(db));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred.' });
  });

  return app;
}

module.exports = { createApp };
