const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  return money.format(value);
}

// SQLite stores UTC timestamps as "YYYY-MM-DD HH:MM:SS".
function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_LABELS = { available: 'Available', pending: 'Pending sale', sold: 'Sold' };

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Form helpers: trim strings, turn blanks into null, parse numbers safely.
function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().slice(0, max);
  return s === '' ? null : s;
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

module.exports = { formatMoney, formatDate, statusLabel, text, number };
