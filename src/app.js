const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./sessionStore');
const db_ = require('./db');
const { loadUser, requireLogin, csrf } = require('./auth');
const format = require('./format');
const { today } = require('./deals');

function createApp(db, options = {}) {
  const app = express();
  const uploadDir = options.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');

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

  const tasksDueStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE assigned_to = ? AND done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?'
  );

  app.use((req, res, next) => {
    Object.assign(res.locals, {
      formatMoney: format.formatMoney,
      formatMoneyCents: format.formatMoneyCents,
      formatDate: format.formatDate,
      formatDateTime: format.formatDateTime,
      daysSince: format.daysSince,
      statusLabel: format.statusLabel,
      today,
      ROLES: db_.ROLES,
      LEAD_STATUSES: db_.LEAD_STATUSES,
      LEAD_SOURCES: db_.LEAD_SOURCES,
      LAND_STATUSES: db_.LAND_STATUSES,
      FINANCING_TYPES: db_.FINANCING_TYPES,
      PAYMENT_KINDS: db_.PAYMENT_KINDS,
      PAYMENT_METHODS: db_.PAYMENT_METHODS,
      NOTE_KINDS: db_.NOTE_KINDS,
      COMMISSION_PLANS: db_.COMMISSION_PLANS,
      JOB_CATEGORIES: db_.JOB_CATEGORIES,
      APPLICATION_STATUSES: db_.APPLICATION_STATUSES,
      DOCUMENT_TYPES: db_.DOCUMENT_TYPES,
      EXPENSE_CATEGORIES: db_.EXPENSE_CATEGORIES,
      EXPENSE_METHODS: db_.EXPENSE_METHODS,
      HOME_TYPES: db_.HOME_TYPES,
      settings: db_.getSettings(db),
    });
    req.flash = (type, message, link = null) => {
      req.session.flash = { type, message, link };
    };
    res.locals.tasksDue = req.user ? tasksDueStmt.get(req.user.id, today()).n : 0;
    res.locals.currentPath = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  app.use(csrf);

  app.use(require('./routes/auth')(db));
  app.use(requireLogin);
  app.use(require('./routes/dashboard')(db));
  app.use('/inventory', require('./routes/inventory')(db, { uploadDir }));
  app.use('/photos', require('./routes/photos')(db, { uploadDir }));
  app.use('/customers', require('./routes/credit')(db));
  app.use('/customers', require('./routes/customers')(db));
  app.use('/users', require('./routes/users')(db));
  app.use('/deals', require('./routes/deals')(db));
  app.use('/notes', require('./routes/notes')(db));
  app.use('/tasks', require('./routes/tasks')(db));
  app.use('/reports', require('./routes/reports')(db));
  app.use('/settings', require('./routes/settings')(db));
  app.use('/books', require('./routes/books')(db));
  app.use('/my/commissions', require('./routes/books').myCommissions(db));
  app.use(require('./routes/search')(db));

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
