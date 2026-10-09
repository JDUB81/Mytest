const path = require('path');
const express = require('express');
const { HOME_TYPES, LAND_STATUSES, getSettings } = require('../db');
const { text, number } = require('../format');
const { logActivity, today } = require('../deals');
const { budgetsFor } = require('../credit');

// Homes the public can see: listed on the website and not yet sold or under contract.
const PUBLIC_HOME = "i.show_on_website = 1 AND i.status = 'available'";

const SORTS = {
  featured: "i.featured DESC, i.listing = 'order' ASC, i.price IS NULL, i.price ASC",
  price_low: 'i.price IS NULL, i.price ASC',
  price_high: 'i.price DESC',
  newest: 'i.created_at DESC, i.id DESC',
};

// Lead forms are open to anyone, so limit how often one address can submit.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;

const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Monthly payment estimate shown on listings: price less 10% down, at the first lender rule's rate and term.
function paymentEstimate(price, lender) {
  if (!price || !lender) return null;
  const loan = price * 0.9;
  const r = lender.rate / 100 / 12;
  const n = lender.term_months;
  const payment = r ? (loan * r) / (1 - Math.pow(1 + r, -n)) : loan / n;
  return { payment: Math.round(payment), rate: lender.rate, years: Math.round(n / 12) };
}

module.exports = function siteRoutes(db, { uploadDir }) {
  const router = express.Router();
  const recent = new Map();

  const homesQuery = (where, order, limit) =>
    db.prepare(`
      SELECT i.id, i.stock_number, i.manufacturer, i.model, i.year, i.home_type, i.bedrooms, i.bathrooms,
        i.square_feet, i.width_ft, i.length_ft, i.price, i.features, i.web_description, i.listing, i.featured,
        i.exterior_color,
        (SELECT id FROM photos p WHERE p.inventory_id = i.id ORDER BY p.id LIMIT 1) AS photo_id
      FROM inventory i WHERE ${PUBLIC_HOME} ${where ? 'AND ' + where : ''}
      ORDER BY ${order} ${limit ? 'LIMIT ' + limit : ''}
    `);
  const featuredHomes = homesQuery('', SORTS.featured, 6);
  const countHomes = db.prepare(`SELECT COUNT(*) AS n, MIN(price) AS min_price FROM inventory i WHERE ${PUBLIC_HOME}`);
  const publicHome = db.prepare(`SELECT * FROM inventory i WHERE i.id = ? AND ${PUBLIC_HOME}`);
  const homePhotos = db.prepare('SELECT id, original_name FROM photos WHERE inventory_id = ? ORDER BY id');
  const publicPhoto = db.prepare(`
    SELECT p.filename, p.mime_type FROM photos p JOIN inventory i ON i.id = p.inventory_id
    WHERE p.id = ? AND ${PUBLIC_HOME}
  `);
  const firstLender = db.prepare('SELECT * FROM lender_profiles WHERE active = 1 ORDER BY sort, name LIMIT 1');
  const byEmail = db.prepare('SELECT * FROM customers WHERE email IS NOT NULL AND lower(email) = lower(?) ORDER BY id DESC LIMIT 1');
  const withPhones = db.prepare("SELECT id, phone FROM customers WHERE phone IS NOT NULL AND phone != '' ORDER BY id DESC");
  const customerById = db.prepare('SELECT * FROM customers WHERE id = ?');
  const insertCustomer = db.prepare(`
    INSERT INTO customers (first_name, last_name, phone, email, lead_source, lead_status, desired_bedrooms, land_status, budget)
    VALUES (@first_name, @last_name, @phone, @email, 'Website', 'new', @desired_bedrooms, @land_status, @budget)
  `);
  const insertNote = db.prepare("INSERT INTO notes (customer_id, inventory_id, kind, body) VALUES (?, ?, 'note', ?)");
  const insertTask = db.prepare('INSERT INTO tasks (title, details, due_date, customer_id, assigned_to) VALUES (?, ?, ?, ?, ?)');
  const firstManager = db.prepare("SELECT id FROM users WHERE role = 'manager' AND active = 1 ORDER BY id LIMIT 1");
  const activeUser = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1');
  const creditApp = db.prepare('SELECT id FROM credit_apps WHERE customer_id = ?');
  const insertCreditApp = db.prepare('INSERT INTO credit_apps (customer_id, data) VALUES (?, ?)');

  function rateLimited(req) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const hits = (recent.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.size > 5000) recent.clear();
    if (hits.length >= MAX_PER_WINDOW) {
      recent.set(key, hits);
      return true;
    }
    hits.push(now);
    recent.set(key, hits);
    return false;
  }

  function findCustomer(phone, email) {
    if (email) {
      const c = byEmail.get(email);
      if (c) return c;
    }
    const d = digits(phone);
    if (d.length >= 7) {
      const match = withPhones.all().find((c) => digits(c.phone) === d);
      if (match) return customerById.get(match.id);
    }
    return null;
  }

  // Creates (or finds) the customer for a web lead, files the message as a note and
  // gives the salesperson (or the first manager) a call-back task due today.
  function recordLead({ first_name, last_name, phone, email, message, homeId, subject, extra = {} }) {
    return db.transaction(() => {
      let customer = findCustomer(phone, email);
      const isNew = !customer;
      if (isNew) {
        const info = insertCustomer.run({
          first_name, last_name, phone, email,
          desired_bedrooms: extra.desired_bedrooms ?? null,
          land_status: extra.land_status ?? null,
          budget: extra.budget ?? null,
        });
        customer = customerById.get(info.lastInsertRowid);
      }
      const home = homeId ? publicHome.get(homeId) : null;
      const homeText = home ? ` about stock #${home.stock_number} (${home.year || ''} ${home.model})` : '';
      insertNote.run(customer.id, home ? home.id : null, `${subject}${homeText} from the website:\n${message || '(no message)'}`);
      const owner = (customer.salesperson_id && activeUser.get(customer.salesperson_id)) || firstManager.get();
      insertTask.run(
        `Call back website lead: ${customer.first_name} ${customer.last_name}`,
        `${subject}${homeText}. ${phone ? 'Phone ' + phone + '. ' : ''}${email ? 'Email ' + email + '.' : ''}`,
        today(),
        customer.id,
        owner ? owner.id : null
      );
      logActivity(db, {
        customerId: customer.id,
        inventoryId: home ? home.id : null,
        message: `${subject}${homeText} from the website${isNew ? ' (new lead)' : ''}`,
      });
      return customer;
    })();
  }

  function parseContact(body) {
    const values = {
      first_name: text(body.first_name, 60),
      last_name: text(body.last_name, 60),
      phone: text(body.phone, 30),
      email: text(body.email, 120),
      message: text(body.message, 2000),
    };
    const errors = [];
    if (!values.first_name || !values.last_name) errors.push('Please enter your first and last name.');
    if (!values.phone && !values.email) errors.push('Please enter a phone number or email so we can reach you.');
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Please check your email address.');
    return { values, errors };
  }

  function render(res, view, locals) {
    const settings = getSettings(db);
    res.render(`site/${view}`, {
      site: settings,
      showPrices: Boolean(settings.site_show_prices),
      homeCount: countHomes.get(),
      HOME_TYPES,
      LAND_STATUSES,
      errors: [],
      values: {},
      ...locals,
    });
  }

  // Signed-in staff land on their dashboard; everyone else sees the website.
  router.get('/', (req, res, next) => {
    if (req.user && !req.query.preview) return next();
    const lender = firstLender.get();
    const homes = featuredHomes.all().map((h) => ({ ...h, estimate: paymentEstimate(h.price, lender) }));
    render(res, 'home', { title: 'Home', homes, page: 'home' });
  });

  router.get('/homes', (req, res) => {
    const type = HOME_TYPES.includes(req.query.type) ? req.query.type : '';
    const beds = number(req.query.beds, { integer: true, max: 20 }).value;
    const maxPrice = number(req.query.max_price, { max: 100000000 }).value;
    const listing = ['stock', 'order'].includes(req.query.listing) ? req.query.listing : '';
    const sort = SORTS[req.query.sort] ? req.query.sort : 'featured';
    const where = [];
    const params = {};
    if (type) {
      where.push('i.home_type = @type');
      params.type = type;
    }
    if (beds) {
      where.push('i.bedrooms >= @beds');
      params.beds = beds;
    }
    if (maxPrice) {
      where.push('i.price <= @maxPrice');
      params.maxPrice = maxPrice;
    }
    if (listing) {
      where.push('i.listing = @listing');
      params.listing = listing;
    }
    const lender = firstLender.get();
    const homes = homesQuery(where.join(' AND '), SORTS[sort]).all(params).map((h) => ({ ...h, estimate: paymentEstimate(h.price, lender) }));
    render(res, 'homes', {
      title: 'Homes for sale',
      homes,
      filters: { type, beds: beds || '', max_price: maxPrice || '', listing, sort },
      page: 'homes',
    });
  });

  router.get('/homes/:id', (req, res) => {
    const home = publicHome.get(Number(req.params.id));
    if (!home) return render(res.status(404), 'gone', { title: 'Home not available', page: 'homes' });
    const { invoice_cost, freight_cost, other_cost, notes, location, serial_number, ...safe } = home; // eslint-disable-line no-unused-vars
    render(res, 'home-detail', {
      title: `${home.year || ''} ${home.model}`.trim(),
      home: safe,
      photos: homePhotos.all(home.id),
      estimate: paymentEstimate(home.price, firstLender.get()),
      page: 'homes',
    });
  });

  router.get('/financing', (req, res) => {
    render(res, 'financing', { title: 'Financing & pre-qualification', page: 'financing', result: null });
  });

  router.post('/financing', (req, res) => {
    if (req.body.website) return res.redirect('/thanks'); // honeypot: only bots fill the hidden field
    const { values, errors } = parseContact(req.body);
    const money = (key, label) => {
      const parsed = number(req.body[key], { max: 10000000 });
      if (parsed.error) errors.push(`${label} must be a number.`);
      return parsed.error ? 0 : parsed.value || 0;
    };
    Object.assign(values, {
      monthly_income: money('monthly_income', 'Monthly income'),
      other_income: money('other_income', 'Other income'),
      monthly_debts: money('monthly_debts', 'Monthly payments'),
      down_payment: money('down_payment', 'Down payment'),
      land_status: Object.keys(LAND_STATUSES).includes(req.body.land_status) ? req.body.land_status : '',
      bedrooms: number(req.body.bedrooms, { integer: true, max: 10 }).value || null,
    });
    if (!values.monthly_income) errors.push('Please enter your household income before taxes.');
    if (errors.length) {
      return render(res.status(400), 'financing', { title: 'Financing & pre-qualification', page: 'financing', result: null, errors, values });
    }
    if (rateLimited(req)) {
      return render(res.status(429), 'financing', {
        title: 'Financing & pre-qualification', page: 'financing', result: null, values,
        errors: ['We’ve received several requests from you already. Please call us instead.'],
      });
    }

    const landMap = { owns: 'Land I own', buying: 'Land I am buying', family: 'Family land', community: 'Rented lot / community', looking: 'Undecided' };
    const appData = {
      a_first_name: values.first_name,
      a_last_name: values.last_name,
      a_phone: values.phone,
      a_email: values.email,
      a_monthly_income: values.monthly_income,
      a_other_income: values.other_income || '',
      a_debt_other: values.monthly_debts || '',
      down_payment: values.down_payment || '',
      land_type: landMap[values.land_status] || '',
    };
    const { best } = budgetsFor(db, appData);
    const estimate = best && best.maxPrice > 0 ? Math.floor(best.maxPrice / 5000) * 5000 : 0;

    const customer = recordLead({
      ...values,
      subject: 'Pre-qualification request',
      message: [
        `Household income $${values.monthly_income}/mo` + (values.other_income ? ` + other $${values.other_income}/mo` : ''),
        `Monthly payments $${values.monthly_debts}`,
        `Down payment $${values.down_payment}`,
        values.land_status ? `Land: ${LAND_STATUSES[values.land_status]}` : '',
        values.bedrooms ? `Wants ${values.bedrooms}+ bedrooms` : '',
        estimate ? `Website estimate shown: about $${estimate.toLocaleString('en-US')}` : '',
        values.message,
      ].filter(Boolean).join('\n'),
      extra: { desired_bedrooms: values.bedrooms, land_status: values.land_status || null, budget: estimate || null },
    });
    // Start their credit application with what they told us (never overwrite one staff already started).
    if (!creditApp.get(customer.id)) insertCreditApp.run(customer.id, JSON.stringify(appData));

    const fits = estimate
      ? homesQuery('i.price <= @max', SORTS.price_high, 6).all({ max: estimate })
      : [];
    render(res, 'financing', { title: 'Your estimate', page: 'financing', result: { estimate, fits, name: values.first_name } });
  });

  router.get('/about', (req, res) => render(res, 'about', { title: 'About us', page: 'about' }));

  router.get('/contact', (req, res) => {
    const home = req.query.home ? publicHome.get(Number(req.query.home)) : null;
    render(res, 'contact', { title: 'Contact us', page: 'contact', home });
  });

  router.post('/inquire', (req, res) => {
    if (req.body.website) return res.redirect('/thanks');
    const { values, errors } = parseContact(req.body);
    const homeId = Number(req.body.home_id) || null;
    const home = homeId ? publicHome.get(homeId) : null;
    let status = 400;
    if (!errors.length && rateLimited(req)) {
      status = 429;
      errors.push('We’ve received several messages from you already. Please call us instead.');
    }
    if (errors.length) {
      return render(res.status(status), 'contact', {
        title: 'Contact us', page: 'contact', home, errors, values,
      });
    }
    recordLead({ ...values, homeId: home ? home.id : null, subject: home ? 'Inquiry' : 'Message' });
    res.redirect('/thanks');
  });

  router.get('/thanks', (req, res) => render(res, 'thanks', { title: 'Thank you', page: '' }));

  // Photos of homes listed on the website (staff use /photos for everything else).
  router.get('/media/:id', (req, res) => {
    const photo = publicPhoto.get(Number(req.params.id));
    if (!photo) return res.status(404).end();
    res.type(photo.mime_type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(uploadDir, photo.filename), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  return router;
};
