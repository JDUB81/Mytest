const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROLES = {
  manager: 'Manager',
  sales: 'Sales Associate',
};

const INVENTORY_STATUSES = ['available', 'pending', 'sold'];

const HOME_TYPES = ['Single-wide', 'Double-wide', 'Triple-wide', 'Modular', 'Tiny home', 'Park model'];

const LEAD_STATUSES = {
  new: 'New lead',
  contacted: 'Contacted',
  appointment: 'Appointment set',
  application: 'Credit application',
  approved: 'Approved / shopping',
  under_contract: 'Under contract',
  closed: 'Closed (bought)',
  lost: 'Lost',
};

const LEAD_SOURCES = [
  'Walk-in', 'Drive-by / sign', 'Referral', 'Website', 'Facebook', 'Google', 'Phone call',
  'Repeat customer', 'Lender referral', 'Community / park', 'Other',
];

const LAND_STATUSES = {
  owns: 'Owns land',
  buying: 'Buying land',
  family: 'Family land',
  community: 'Needs lot in community / park',
  looking: 'Still looking',
};

const FINANCING_TYPES = {
  cash: 'Cash',
  chattel: 'Chattel (home only)',
  land_home: 'Land-home / mortgage',
  fha: 'FHA',
  va: 'VA',
  usda: 'USDA',
  in_house: 'In-house / owner finance',
  other: 'Other',
};

const PAYMENT_KINDS = { deposit: 'Deposit', payment: 'Payment', refund: 'Refund' };
const PAYMENT_METHODS = {
  cash: 'Cash', check: 'Check', card: 'Card', ach: 'ACH / bank transfer', wire: 'Wire', lender: 'Lender funding', other: 'Other',
};
// Starting jobs & add-ons list: [name, category, taxable].
const DEFAULT_JOBS = [
  ['Delivery & setup — single-wide', 'Delivery & setup', 1],
  ['Delivery & setup — double-wide', 'Delivery & setup', 1],
  ['Delivery & setup — triple-wide', 'Delivery & setup', 1],
  ['Escort / oversize transport', 'Delivery & setup', 1],
  ['Blocking, leveling & tie-downs', 'Delivery & setup', 1],
  ['Central A/C', 'HVAC', 1],
  ['Heat pump', 'HVAC', 1],
  ['HVAC hookup & ductwork', 'HVAC', 1],
  ['Vinyl skirting', 'Exterior', 1],
  ['Brick / masonry skirting', 'Exterior', 1],
  ['Steps / porch', 'Exterior', 1],
  ['Deck', 'Exterior', 1],
  ['Gutters', 'Exterior', 1],
  ['Foundation / pad', 'Site work', 1],
  ['Site prep & grading', 'Site work', 1],
  ['Driveway', 'Site work', 1],
  ['Utility hookups (water/sewer/electric)', 'Utilities', 1],
  ['Electrical service / meter pole', 'Utilities', 1],
  ['Plumbing hookup', 'Utilities', 1],
  ['Septic system', 'Utilities', 1],
  ['Well', 'Utilities', 1],
  ['Appliance package', 'Home options', 1],
  ['Washer & dryer', 'Home options', 1],
  ['Extended warranty', 'Home options', 0],
  ['Permits', 'Permits & fees', 0],
  ['Title & registration', 'Permits & fees', 0],
  ['Survey / engineer letter', 'Permits & fees', 0],
];

const JOB_CATEGORIES = ['Delivery & setup', 'HVAC', 'Exterior', 'Site work', 'Utilities', 'Home options', 'Permits & fees', 'Other'];

const APPLICATION_STATUSES = {
  submitted: 'Submitted',
  pending: 'Pending / more info',
  conditional: 'Conditional approval',
  approved: 'Approved',
  countered: 'Counter-offer',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

// Stips commonly requested by manufactured-home lenders.
const DOCUMENT_TYPES = {
  photo_id: 'Photo ID (applicant)',
  co_photo_id: 'Photo ID (co-applicant)',
  ss_card: 'Social Security card(s)',
  paystubs: 'Recent paystubs',
  w2_tax: 'W-2s / tax returns',
  bank_statements: 'Bank statements',
  award_letter: 'Benefit / award letter (SSI, disability, pension)',
  proof_residence: 'Proof of residence (utility bill)',
  land_deed: 'Land deed / lease / park approval',
  landlord_ref: 'Rental history / landlord reference',
  insurance: 'Homeowner insurance binder',
  signed_app: 'Signed credit application',
  down_payment: 'Down payment verification',
};

const COMMISSION_PLANS = {
  none: 'No commission',
  sales: 'Salesperson — % of each deal\u2019s gross profit',
  gm: 'General manager — % of the lot\u2019s monthly net profit',
};

const EXPENSE_CATEGORIES = {
  job: 'Deal job cost (setup, HVAC, etc.)',
  inventory: 'Inventory purchase / freight',
  commission: 'Commission payout',
  payroll: 'Payroll',
  rent: 'Rent / lot lease',
  utilities: 'Utilities',
  advertising: 'Advertising',
  insurance: 'Insurance',
  maintenance: 'Lot & office maintenance',
  office: 'Office & supplies',
  fees: 'Bank & professional fees',
  taxes: 'Taxes & licenses',
  other: 'Other overhead',
};
// Categories that are NOT overhead: job costs and home costs are already counted in
// each deal's profit, and commission payouts settle the commission ledger.
const NON_OVERHEAD = ['job', 'inventory', 'commission'];

const EXPENSE_METHODS = { check: 'Check', ach: 'ACH / transfer', card: 'Card', cash: 'Cash', other: 'Other' };

const NOTE_KINDS = { note: 'Note', call: 'Phone call', text: 'Text', email: 'Email', visit: 'Visit / showing' };

const DEFAULT_SETTINGS = {
  business_name: 'Premier Homes',
  business_address: '',
  business_phone: '',
  business_email: '',
  default_tax_rate: '0',
  default_doc_fee: '0',
  sales_commission_percent: '25',
  gm_commission_percent: '35',
  next_check_number: '1001',
  budget_insurance_monthly: '100',
  deposit_terms:
    'Deposits hold the selected home for the buyer. Refund terms are subject to the purchase agreement.',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('manager', 'sales')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_number   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  manufacturer   TEXT NOT NULL,
  model          TEXT NOT NULL,
  year           INTEGER,
  home_type      TEXT NOT NULL,
  serial_number  TEXT,
  bedrooms       INTEGER,
  bathrooms      REAL,
  square_feet    INTEGER,
  width_ft       INTEGER,
  length_ft      INTEGER,
  price          REAL,
  location       TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'pending', 'sold')),
  customer_id    INTEGER REFERENCES customers(id),
  assigned_by    INTEGER REFERENCES users(id),
  assigned_at    TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status);
CREATE INDEX IF NOT EXISTS idx_inventory_customer ON inventory(customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

// Each entry runs once, in order; PRAGMA user_version records how many have run.
// Never edit a shipped migration: add a new one instead.
const MIGRATIONS = [
  (db) => db.exec(SCHEMA),
  (db) => {
    db.exec(`
      ALTER TABLE inventory ADD COLUMN invoice_cost REAL;
      ALTER TABLE inventory ADD COLUMN freight_cost REAL;
      ALTER TABLE inventory ADD COLUMN other_cost REAL;
      ALTER TABLE inventory ADD COLUMN arrival_date TEXT;
      ALTER TABLE inventory ADD COLUMN exterior_color TEXT;
      ALTER TABLE inventory ADD COLUMN features TEXT;

      ALTER TABLE customers ADD COLUMN lead_status TEXT NOT NULL DEFAULT 'new';
      ALTER TABLE customers ADD COLUMN lead_source TEXT;
      ALTER TABLE customers ADD COLUMN salesperson_id INTEGER REFERENCES users(id);
      ALTER TABLE customers ADD COLUMN budget REAL;
      ALTER TABLE customers ADD COLUMN desired_bedrooms INTEGER;
      ALTER TABLE customers ADD COLUMN land_status TEXT;
      ALTER TABLE customers ADD COLUMN land_location TEXT;
      ALTER TABLE customers ADD COLUMN financing_pref TEXT;
      ALTER TABLE customers ADD COLUMN preferred_contact TEXT;
      ALTER TABLE customers ADD COLUMN follow_up_date TEXT;
      ALTER TABLE customers ADD COLUMN co_buyer_name TEXT;
      ALTER TABLE customers ADD COLUMN co_buyer_phone TEXT;
      ALTER TABLE customers ADD COLUMN co_buyer_email TEXT;

      CREATE TABLE deals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id     INTEGER NOT NULL REFERENCES customers(id),
        inventory_id    INTEGER NOT NULL REFERENCES inventory(id),
        salesperson_id  INTEGER REFERENCES users(id),
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sold', 'cancelled')),
        sale_price      REAL NOT NULL DEFAULT 0,
        discount        REAL NOT NULL DEFAULT 0,
        trade_description TEXT,
        trade_allowance REAL NOT NULL DEFAULT 0,
        trade_payoff    REAL NOT NULL DEFAULT 0,
        tax_rate        REAL NOT NULL DEFAULT 0,
        doc_fee         REAL NOT NULL DEFAULT 0,
        financing_type  TEXT,
        lender          TEXT,
        delivery_date   TEXT,
        delivery_address TEXT,
        notes           TEXT,
        cancel_reason   TEXT,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        sold_at         TEXT,
        cancelled_at    TEXT
      );
      CREATE INDEX idx_deals_customer ON deals(customer_id);
      CREATE INDEX idx_deals_inventory ON deals(inventory_id);
      CREATE INDEX idx_deals_status ON deals(status);

      CREATE TABLE deal_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        price       REAL NOT NULL DEFAULT 0,
        cost        REAL,
        taxable     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_deal_items_deal ON deal_items(deal_id);

      CREATE TABLE payments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id      INTEGER NOT NULL REFERENCES deals(id),
        kind         TEXT NOT NULL CHECK (kind IN ('deposit', 'payment', 'refund')),
        amount       REAL NOT NULL CHECK (amount > 0),
        method       TEXT NOT NULL,
        reference    TEXT,
        received_on  TEXT NOT NULL,
        notes        TEXT,
        received_by  INTEGER REFERENCES users(id),
        voided_at    TEXT,
        voided_by    INTEGER REFERENCES users(id),
        void_reason  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_payments_deal ON payments(deal_id);

      CREATE TABLE notes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id  INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE,
        deal_id      INTEGER REFERENCES deals(id),
        user_id      INTEGER REFERENCES users(id),
        kind         TEXT NOT NULL DEFAULT 'note',
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_notes_customer ON notes(customer_id);
      CREATE INDEX idx_notes_inventory ON notes(inventory_id);

      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL,
        details      TEXT,
        due_date     TEXT,
        customer_id  INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        assigned_to  INTEGER REFERENCES users(id),
        created_by   INTEGER REFERENCES users(id),
        done_at      TEXT,
        done_by      INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, done_at);
      CREATE INDEX idx_tasks_customer ON tasks(customer_id);

      CREATE TABLE photos (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_id  INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL UNIQUE,
        original_name TEXT,
        mime_type     TEXT NOT NULL,
        uploaded_by   INTEGER REFERENCES users(id),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_photos_inventory ON photos(inventory_id);

      CREATE TABLE activity (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER REFERENCES users(id),
        customer_id  INTEGER,
        inventory_id INTEGER,
        deal_id      INTEGER,
        message      TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_activity_customer ON activity(customer_id);
      CREATE INDEX idx_activity_inventory ON activity(inventory_id);
      CREATE INDEX idx_activity_created ON activity(created_at);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Homes already assigned under the first version become deals.
    db.exec(`
      INSERT INTO deals (customer_id, inventory_id, salesperson_id, status, sale_price, created_by, created_at, sold_at)
      SELECT customer_id, id, assigned_by, status, COALESCE(price, 0), assigned_by,
             COALESCE(assigned_at, datetime('now')), CASE WHEN status = 'sold' THEN updated_at END
      FROM inventory WHERE customer_id IS NOT NULL;
      UPDATE customers SET lead_status = 'under_contract'
        WHERE id IN (SELECT customer_id FROM inventory WHERE status = 'pending');
      UPDATE customers SET lead_status = 'closed'
        WHERE id IN (SELECT customer_id FROM inventory WHERE status = 'sold');
    `);
  },
  (db) => {
    db.exec(`
      -- Per-person commission plan: 'none', 'sales' (% of each deal's gross profit)
      -- or 'gm' (% of the lot's monthly net profit).
      ALTER TABLE users ADD COLUMN commission_plan TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE users ADD COLUMN commission_rate REAL;
      ALTER TABLE users ADD COLUMN commission_since TEXT;
      UPDATE users SET commission_plan = 'sales', commission_since = date('now', 'localtime') WHERE role = 'sales';

      CREATE TABLE addon_catalog (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        price       REAL NOT NULL DEFAULT 0,
        cost        REAL NOT NULL DEFAULT 0,
        taxable     INTEGER NOT NULL DEFAULT 1,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      ALTER TABLE deal_items ADD COLUMN catalog_id INTEGER REFERENCES addon_catalog(id);

      -- Commission snapshot taken when a deal is sold, so later rate changes don't rewrite history.
      ALTER TABLE deals ADD COLUMN commission_user_id INTEGER REFERENCES users(id);
      ALTER TABLE deals ADD COLUMN commission_rate REAL;

      CREATE TABLE vendors (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        trade       TEXT,
        contact     TEXT,
        phone       TEXT,
        email       TEXT,
        address     TEXT,
        notes       TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Money going out: checks and other payments.
      CREATE TABLE expenses (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        paid_on       TEXT NOT NULL,
        amount        REAL NOT NULL CHECK (amount > 0),
        method        TEXT NOT NULL,
        check_number  TEXT,
        vendor_id     INTEGER REFERENCES vendors(id),
        payee_user_id INTEGER REFERENCES users(id),
        payee_name    TEXT NOT NULL,
        category      TEXT NOT NULL,
        memo          TEXT,
        deal_id       INTEGER REFERENCES deals(id),
        deal_item_id  INTEGER REFERENCES deal_items(id),
        inventory_id  INTEGER REFERENCES inventory(id),
        created_by    INTEGER REFERENCES users(id),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        voided_at     TEXT,
        voided_by     INTEGER REFERENCES users(id),
        void_reason   TEXT
      );
      CREATE INDEX idx_expenses_deal ON expenses(deal_id);
      CREATE INDEX idx_expenses_paid_on ON expenses(paid_on);
      CREATE INDEX idx_expenses_vendor ON expenses(vendor_id);

      -- Running commission balance per person. Positive = owed to them.
      CREATE TABLE commission_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        kind        TEXT NOT NULL CHECK (kind IN ('earned', 'overrun', 'gm', 'payout', 'adjustment')),
        amount      REAL NOT NULL,
        rate        REAL,
        deal_id     INTEGER REFERENCES deals(id),
        period      TEXT,
        expense_id  INTEGER REFERENCES expenses(id),
        note        TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_commission_user ON commission_entries(user_id);
      CREATE INDEX idx_commission_deal ON commission_entries(deal_id);
    `);
    // The old single commission setting becomes the default rate for salespeople.
    const old = db.prepare("SELECT value FROM settings WHERE key = 'commission_percent'").get();
    if (old && Number(old.value) > 0) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sales_commission_percent', ?)").run(old.value);
    }
  },
  (db) => {
    db.exec(`
      ALTER TABLE addon_catalog ADD COLUMN category TEXT;
      ALTER TABLE addon_catalog ADD COLUMN vendor_id INTEGER REFERENCES vendors(id);

      -- One credit application per customer. Most answers live in a JSON document;
      -- SSNs are encrypted separately (see src/secure.js).
      CREATE TABLE credit_apps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id  INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
        data         TEXT NOT NULL DEFAULT '{}',
        ssn_enc      TEXT,
        co_ssn_enc   TEXT,
        signed_on    TEXT,
        updated_by   INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Lender qualifying rules used to estimate each customer's max budget.
      CREATE TABLE lender_profiles (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        dti_max          REAL NOT NULL,
        pti_max          REAL,
        rate             REAL NOT NULL,
        term_months      INTEGER NOT NULL,
        min_down_percent REAL NOT NULL DEFAULT 0,
        notes            TEXT,
        active           INTEGER NOT NULL DEFAULT 1,
        sort             INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE lender_submissions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        deal_id          INTEGER REFERENCES deals(id),
        lender           TEXT NOT NULL,
        submitted_on     TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'submitted',
        amount_requested REAL,
        amount_approved  REAL,
        rate             REAL,
        term_months      INTEGER,
        payment          REAL,
        conditions       TEXT,
        notes            TEXT,
        created_by       INTEGER REFERENCES users(id),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_submissions_customer ON lender_submissions(customer_id);

      CREATE TABLE customer_documents (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        doc_type     TEXT NOT NULL,
        received_on  TEXT NOT NULL,
        received_by  INTEGER REFERENCES users(id),
        UNIQUE (customer_id, doc_type)
      );
    `);

    // Categorize anything already on the list, then add every standard job that's missing.
    const setCategory = db.prepare('UPDATE addon_catalog SET category = ? WHERE category IS NULL AND name LIKE ?');
    for (const [pattern, category] of [
      ['%setup%', 'Delivery & setup'], ['%A/C%', 'HVAC'], ['%heat pump%', 'HVAC'], ['%HVAC%', 'HVAC'], ['%skirting%', 'Exterior'],
      ['%step%', 'Exterior'], ['%deck%', 'Exterior'], ['%gutter%', 'Exterior'], ['%permit%', 'Permits & fees'],
      ['%septic%', 'Utilities'], ['%well%', 'Utilities'], ['%foundation%', 'Site work'],
    ]) setCategory.run(category, pattern);
    db.prepare("UPDATE addon_catalog SET category = 'Other' WHERE category IS NULL").run();
    const exists = db.prepare('SELECT 1 FROM addon_catalog WHERE lower(name) = lower(?)');
    const addJob = db.prepare('INSERT INTO addon_catalog (name, category, price, cost, taxable) VALUES (?, ?, 0, 0, ?)');
    for (const [name, category, taxable] of DEFAULT_JOBS) if (!exists.get(name)) addJob.run(name, category, taxable);

    const lender = db.prepare(
      'INSERT INTO lender_profiles (name, dti_max, pti_max, rate, term_months, min_down_percent, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    lender.run('21st Mortgage (estimate)', 43, null, 9.99, 240, 0,
      'Placeholder: about 43% max debt-to-income is commonly reported. Replace rate, term and down payment with your current 21st rate sheet.', 1);
    lender.run('Triad Financial (estimate)', 48, null, 9.99, 240, 0,
      'Placeholder: Triad advertises back-end DTI up to 48% with no housing ratio (land-home). Replace rate, term and down payment with your current Triad rate sheet.', 2);
  },
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function getSettings(db) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) settings[row.key] = row.value;
  return settings;
}

function defaultDbPath() {
  return path.join(__dirname, '..', 'data', 'premier-homes.db');
}

function openDatabase(file) {
  const target = file || process.env.DB_PATH || defaultDbPath();
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = {
  openDatabase,
  defaultDbPath,
  MIGRATIONS,
  getSettings,
  ROLES,
  INVENTORY_STATUSES,
  HOME_TYPES,
  LEAD_STATUSES,
  LEAD_SOURCES,
  LAND_STATUSES,
  FINANCING_TYPES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  NOTE_KINDS,
  COMMISSION_PLANS,
  JOB_CATEGORIES,
  APPLICATION_STATUSES,
  DOCUMENT_TYPES,
  EXPENSE_CATEGORIES,
  EXPENSE_METHODS,
  NON_OVERHEAD,
  DEFAULT_SETTINGS,
};
