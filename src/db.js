const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROLES = {
  manager: 'Manager',
  sales: 'Sales Associate',
};

const INVENTORY_STATUSES = ['available', 'pending', 'sold'];

const HOME_TYPES = ['Single-wide', 'Double-wide', 'Triple-wide', 'Modular', 'Tiny home', 'Park model'];

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

function openDatabase(file) {
  const target = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'premier-homes.db');
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase, ROLES, INVENTORY_STATUSES, HOME_TYPES };
