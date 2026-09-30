const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  return money.format(value);
}

function formatMoneyCents(value) {
  if (value === null || value === undefined || value === '') return '—';
  return moneyCents.format(value);
}

// Accepts plain calendar dates ("YYYY-MM-DD", local) and SQLite UTC timestamps
// ("YYYY-MM-DD HH:MM:SS").
function parseDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  if (!value) return '—';
  const d = parseDate(value);
  if (!d) return value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = parseDate(value);
  if (!d) return value;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Whole days between a date/timestamp and now.
function daysSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

const STATUS_LABELS = { available: 'Available', pending: 'Pending sale', sold: 'Sold', cancelled: 'Cancelled' };

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Form helpers: trim strings, turn blanks into null, parse numbers safely.
function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().slice(0, max);
  return s === '' ? null : s;
}

function date(value) {
  const s = text(value, 10);
  if (s === null) return { value: null };
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) ? { value: s } : { error: true };
}

// Pick a value from an allowed list/object of keys, or null.
function choice(value, allowed) {
  const keys = Array.isArray(allowed) ? allowed : Object.keys(allowed);
  return keys.includes(value) ? value : null;
}

function number(value, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = text(value, 40);
  if (s === null) return { value: null };
  const n = Number(s.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    return { error: true };
  }
  return { value: n };
}

module.exports = {
  formatMoney,
  formatMoneyCents,
  formatDate,
  formatDateTime,
  daysSince,
  statusLabel,
  text,
  number,
  date,
  choice,
};
