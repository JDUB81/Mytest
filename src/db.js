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
const NOTE_KINDS = { note: 'Note', call: 'Phone call', text: 'Text', email: 'Email', visit: 'Visit / showing' };

const DEFAULT_SETTINGS = {
  business_name: 'Premier Homes',
  business_address: '',
  business_phone: '',
  business_email: '',
  default_tax_rate: '0',
  default_doc_fee: '0',
  commission_percent: '0',
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
  DEFAULT_SETTINGS,
};
