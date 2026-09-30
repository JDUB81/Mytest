// Bookkeeping: job costs per deal, commission ledgers, and monthly net profit.
//
// Commission rules
//  - Salesperson ('sales' plan): rate × the deal's gross profit, earned when the deal
//    is marked sold. Gross profit uses the *allotted* cost of each add-on.
//  - When the checks written for a job line exceed its allotment, rate × the overrun is
//    charged back to that salesperson's ledger (lowering what's owed on future pay).
//  - General manager ('gm' plan): rate × the lot's net profit for each completed month:
//      Σ deal profit after overruns − salesperson commissions − overhead expenses.
//    Later changes to a closed month post an adjustment instead of rewriting history.
//
// Ledger entries are never edited. Each sync compares what *should* have been posted
// with what *was* posted and records only the difference, so every change is traceable.

const { NON_OVERHEAD, getSettings } = require('./db');
const { loadDealBundle, round2, today } = require('./deals');

const usd = (n) =>
  (n < 0 ? '\u2212$' : '$') + Math.abs(round2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Allotted vs. actually paid for each job on a deal.
function jobCosts(db, deal, items) {
  const expenses = db
    .prepare(`
      SELECT e.*, v.name AS vendor_name FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
      WHERE e.deal_id = ? AND e.voided_at IS NULL ORDER BY e.paid_on, e.id
    `)
    .all(deal.id);
  const lines = items.map((item) => {
    const payments = expenses.filter((e) => e.deal_item_id === item.id);
    const allotted = round2(item.cost || 0);
    const paid = round2(payments.reduce((s, e) => s + e.amount, 0));
    return { key: `item:${item.id}`, item, label: item.description, allotted, paid, payments };
  });
  const misc = expenses.filter((e) => !e.deal_item_id || !items.some((i) => i.id === e.deal_item_id));
  if (misc.length) {
    lines.push({
      key: 'misc',
      item: null,
      label: 'Other / not on the deal',
      allotted: 0,
      paid: round2(misc.reduce((s, e) => s + e.amount, 0)),
      payments: misc,
    });
  }
  for (const l of lines) {
    l.remaining = round2(l.allotted - l.paid);
    l.over = round2(Math.max(0, l.paid - l.allotted));
  }
  return {
    lines,
    expenses,
    allotted: round2(lines.reduce((s, l) => s + l.allotted, 0)),
    paid: round2(lines.reduce((s, l) => s + l.paid, 0)),
    overrun: round2(lines.reduce((s, l) => s + l.over, 0)),
  };
}

function defaultRate(db, plan) {
  const s = getSettings(db);
  return Number(plan === 'gm' ? s.gm_commission_percent : s.sales_commission_percent) || 0;
}

function userRate(db, user) {
  return user.commission_rate ?? defaultRate(db, user.commission_plan);
}

// Who earns commission on a deal and at what rate. Snapshotted the first time the deal
// is sold (or when the salesperson changes) so later rate changes don't rewrite history.
function dealCommissionSnapshot(db, deal) {
  if (deal.commission_user_id === deal.salesperson_id && deal.commission_user_id) {
    return { userId: deal.commission_user_id, rate: deal.commission_rate };
  }
  const user = deal.salesperson_id
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(deal.salesperson_id)
    : null;
  const rate = user && user.commission_plan === 'sales' ? userRate(db, user) : null;
  db.prepare('UPDATE deals SET commission_user_id = ?, commission_rate = ? WHERE id = ?').run(
    user ? user.id : null,
    rate,
    deal.id
  );
  return { userId: user ? user.id : null, rate };
}

// Everything the books need to know about one deal.
function dealFinancials(db, dealId) {
  const bundle = loadDealBundle(db, dealId);
  if (!bundle) return null;
  const { deal, items, totals } = bundle;
  const jobs = jobCosts(db, deal, items);
  const actualProfit = round2(totals.grossProfit - jobs.overrun);
  let commission = null;
  if (deal.status === 'sold') {
    const snap = dealCommissionSnapshot(db, deal);
    if (snap.userId && snap.rate) {
      commission = {
        userId: snap.userId,
        rate: snap.rate,
        earned: round2((snap.rate / 100) * totals.grossProfit),
        overrun: round2(-(snap.rate / 100) * jobs.overrun),
      };
      commission.net = round2(commission.earned + commission.overrun);
    }
  }
  return { ...bundle, jobs, actualProfit, commission };
}

const insertEntry = (db, e) =>
  db
    .prepare(`
      INSERT INTO commission_entries (user_id, kind, amount, rate, deal_id, period, expense_id, note, created_by)
      VALUES (@user_id, @kind, @amount, @rate, @deal_id, @period, @expense_id, @note, @created_by)
    `)
    .run({ rate: null, deal_id: null, period: null, expense_id: null, created_by: null, ...e });

// Bring one deal's salesperson commission entries in line with the deal as it stands now.
function syncDealCommission(db, dealId, actorId = null) {
  const fin = dealFinancials(db, dealId);
  if (!fin) return;
  const { deal, totals, jobs, commission } = fin;
  const targets = new Map(); // `${userId}|${kind}` → amount
  if (commission) {
    targets.set(`${commission.userId}|earned`, commission.earned);
    targets.set(`${commission.userId}|overrun`, commission.overrun);
  }
  const posted = db
    .prepare(`
      SELECT user_id, kind, SUM(amount) AS total FROM commission_entries
      WHERE deal_id = ? AND kind IN ('earned', 'overrun') GROUP BY user_id, kind
    `)
    .all(dealId);
  const keys = new Set([...targets.keys(), ...posted.map((p) => `${p.user_id}|${p.kind}`)]);
  for (const key of keys) {
    const [userId, kind] = key.split('|');
    const want = targets.get(key) || 0;
    const have = round2((posted.find((p) => `${p.user_id}|${p.kind}` === key) || {}).total || 0);
    const diff = round2(want - have);
    if (Math.abs(diff) < 0.01) continue;
    let note;
    if (kind === 'earned') {
      if (!have) note = `Deal #${deal.id} sold — ${commission.rate}% of ${usd(totals.grossProfit)} gross profit`;
      else if (!want) note = `Deal #${deal.id} no longer sold — commission reversed`;
      else note = `Deal #${deal.id} changed — gross profit now ${usd(totals.grossProfit)}`;
    } else if (!want) {
      note = `Deal #${deal.id} — job cost charge-back reversed`;
    } else {
      note = `Deal #${deal.id} job costs ${usd(jobs.overrun)} over allotment — ${commission.rate}% charged back`;
    }
    insertEntry(db, {
      user_id: Number(userId),
      kind,
      amount: diff,
      rate: commission ? commission.rate : null,
      deal_id: deal.id,
      note,
      created_by: actorId,
    });
  }
}

// Net profit of the lot for one month ("YYYY-MM").
function monthProfit(db, period) {
  const dealIds = db
    .prepare("SELECT id FROM deals WHERE status = 'sold' AND strftime('%Y-%m', sold_at, 'localtime') = ?")
    .all(period)
    .map((r) => r.id);
  const deals = dealIds.map((id) => dealFinancials(db, id));
  const revenue = round2(deals.reduce((s, f) => s + f.totals.homeNet + f.totals.itemsTotal + f.deal.doc_fee, 0));
  const grossProfit = round2(deals.reduce((s, f) => s + f.totals.grossProfit, 0));
  const overruns = round2(deals.reduce((s, f) => s + f.jobs.overrun, 0));
  const salesCommissions = round2(deals.reduce((s, f) => s + (f.commission ? f.commission.net : 0), 0));
  const overheadRows = db
    .prepare(`
      SELECT category, SUM(amount) AS total FROM expenses
      WHERE voided_at IS NULL AND deal_id IS NULL AND strftime('%Y-%m', paid_on) = ?
        AND category NOT IN (${NON_OVERHEAD.map(() => '?').join(',')})
      GROUP BY category ORDER BY total DESC
    `)
    .all(period, ...NON_OVERHEAD);
  const overhead = round2(overheadRows.reduce((s, r) => s + r.total, 0));
  return {
    period,
    label: monthLabel(period),
    units: deals.length,
    deals,
    revenue,
    grossProfit,
    overruns,
    salesCommissions,
    overheadRows,
    overhead,
    netProfit: round2(grossProfit - overruns - salesCommissions - overhead),
  };
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

function previousMonth(period) {
  let [y, m] = period.split('-').map(Number);
  m -= 1;
  if (m < 1) [y, m] = [y - 1, 12];
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Deals sold before commission tracking existed (or never synced) get their entries now.
function backfillDealCommissions(db) {
  const ids = db.prepare("SELECT id FROM deals WHERE status = 'sold' AND commission_user_id IS NULL AND salesperson_id IS NOT NULL").all();
  for (const { id } of ids) syncDealCommission(db, id, null);
}

// Post general-manager commission for every completed month since each GM started.
function syncGmCommissions(db, actorId = null) {
  backfillDealCommissions(db);
  const gms = db.prepare("SELECT * FROM users WHERE commission_plan = 'gm'").all();
  if (!gms.length) return;
  const lastClosed = previousMonth(today().slice(0, 7));
  const cache = new Map();
  const profit = (p) => {
    if (!cache.has(p)) cache.set(p, monthProfit(db, p));
    return cache.get(p);
  };
  for (const gm of gms) {
    const start = (gm.commission_since || today()).slice(0, 7);
    if (start > lastClosed) continue;
    for (const period of monthsBetween(start, lastClosed)) {
      const posted = db
        .prepare("SELECT SUM(amount) AS total, MIN(id) AS first FROM commission_entries WHERE user_id = ? AND kind = 'gm' AND period = ?")
        .get(gm.id, period);
      const rate = posted.first
        ? db.prepare('SELECT rate FROM commission_entries WHERE id = ?').get(posted.first).rate
        : userRate(db, gm);
      const month = profit(period);
      const want = round2((rate / 100) * month.netProfit);
      const have = round2(posted.total || 0);
      const diff = round2(want - have);
      // Always write the first entry for a month (even $0) so the rate is locked in.
      if (posted.first && Math.abs(diff) < 0.01) continue;
      insertEntry(db, {
        user_id: gm.id,
        kind: 'gm',
        amount: diff,
        rate,
        period,
        note: posted.first
          ? `${month.label} recalculated — net profit now ${usd(month.netProfit)}`
          : `${month.label} — ${rate}% of ${usd(month.netProfit)} net profit`,
        created_by: actorId,
      });
    }
  }
}

function ledgerBalances(db) {
  return db
    .prepare(`
      SELECT u.id, u.full_name, u.commission_plan, u.commission_rate, u.active,
        COALESCE(SUM(CASE WHEN e.kind IN ('earned', 'gm') THEN e.amount END), 0) AS earned,
        COALESCE(SUM(CASE WHEN e.kind = 'overrun' THEN e.amount END), 0) AS overruns,
        COALESCE(SUM(CASE WHEN e.kind = 'adjustment' THEN e.amount END), 0) AS adjustments,
        COALESCE(SUM(CASE WHEN e.kind = 'payout' THEN e.amount END), 0) AS paid,
        COALESCE(SUM(e.amount), 0) AS balance
      FROM users u LEFT JOIN commission_entries e ON e.user_id = u.id
      WHERE u.commission_plan != 'none' OR e.id IS NOT NULL
      GROUP BY u.id ORDER BY u.active DESC, u.full_name
    `)
    .all()
    .map((r) => ({ ...r, rate: userRate(db, r) }));
}

// "One thousand two hundred thirty-four and 56/100"
function amountInWords(amount) {
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
    'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under1000 = (n) => {
    const parts = [];
    if (n >= 100) {
      parts.push(`${ones[Math.floor(n / 100)]} hundred`);
      n %= 100;
    }
    if (n >= 20) {
      parts.push(tens[Math.floor(n / 10)] + (n % 10 ? `-${ones[n % 10]}` : ''));
    } else if (n > 0) parts.push(ones[n]);
    return parts.join(' ');
  };
  const cents = Math.round(amount * 100) % 100;
  let dollars = Math.floor(Math.round(amount * 100) / 100);
  if (dollars === 0) return `Zero and ${String(cents).padStart(2, '0')}/100`;
  const groups = [];
  for (const scale of ['', ' thousand', ' million']) {
    const chunk = dollars % 1000;
    if (chunk) groups.unshift(under1000(chunk) + scale);
    dollars = Math.floor(dollars / 1000);
    if (!dollars) break;
  }
  const words = groups.join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${String(cents).padStart(2, '0')}/100`;
}

module.exports = {
  jobCosts,
  dealFinancials,
  syncDealCommission,
  syncGmCommissions,
  backfillDealCommissions,
  monthProfit,
  monthsBetween,
  previousMonth,
  monthLabel,
  ledgerBalances,
  insertEntry,
  userRate,
  defaultRate,
  amountInWords,
};
