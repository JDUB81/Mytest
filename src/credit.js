// Credit application fields and the max-budget estimate built from them.
const { round2 } = require('./deals');
const { getSettings } = require('./db');
const { decrypt } = require('./secure');

// Fields asked of the applicant and (optionally) the co-applicant. Stored with an
// "a_" or "c_" prefix. type: text | date | money | number | select
const PERSON_FIELDS = [
  { section: 'Personal' },
  { key: 'first_name', label: 'First name' },
  { key: 'middle_name', label: 'Middle name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'dob', label: 'Date of birth', type: 'date' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'marital', label: 'Marital status', type: 'select', options: ['Married', 'Unmarried', 'Separated'] },
  { key: 'dependents', label: 'Dependents', type: 'number' },
  { key: 'dl_number', label: 'Driver license # / state' },
  { section: 'Residence' },
  { key: 'address', label: 'Current address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'years_at_address', label: 'Years there', type: 'number' },
  { key: 'housing', label: 'Own or rent', type: 'select', options: ['Rent', 'Own', 'Live with family', 'Other'] },
  { key: 'housing_payment', label: 'Monthly rent / mortgage', type: 'money' },
  { key: 'landlord', label: 'Landlord / mortgage company & phone' },
  { key: 'prev_address', label: 'Previous address (if under 2 years)' },
  { section: 'Employment & income' },
  { key: 'employer', label: 'Employer' },
  { key: 'employer_phone', label: 'Employer phone' },
  { key: 'position', label: 'Position / title' },
  { key: 'years_employed', label: 'Years employed', type: 'number' },
  { key: 'monthly_income', label: 'Gross monthly income', type: 'money' },
  { key: 'other_income', label: 'Other monthly income', type: 'money' },
  { key: 'other_income_source', label: 'Other income source (SSI, pension, child support…)' },
  { key: 'prev_employer', label: 'Previous employer (if under 2 years)' },
  { section: 'Monthly debts' },
  { key: 'debt_auto', label: 'Vehicle payments', type: 'money' },
  { key: 'debt_cards', label: 'Credit card minimums', type: 'money' },
  { key: 'debt_other', label: 'Other loans / child support', type: 'money' },
  { key: 'bankruptcy', label: 'Bankruptcy or foreclosure', type: 'select', options: ['None', 'Discharged', 'Open / in progress', 'Foreclosure'] },
  { key: 'bankruptcy_date', label: 'When', type: 'date' },
];

// Questions about the purchase as a whole.
const PURCHASE_FIELDS = [
  { section: 'Purchase' },
  { key: 'home_desc', label: 'Home (year / make / model / stock #)' },
  { key: 'home_price', label: 'Purchase price', type: 'money' },
  { key: 'down_payment', label: 'Down payment available', type: 'money' },
  { key: 'down_payment_source', label: 'Down payment source' },
  { key: 'land_type', label: 'Home will be placed on', type: 'select', options: ['Land I own', 'Land I am buying', 'Family land', 'Rented lot / community', 'Undecided'] },
  { key: 'land_address', label: 'Placement address / community' },
  { key: 'lot_rent', label: 'Monthly lot rent', type: 'money' },
  { section: 'References' },
  { key: 'ref1_name', label: 'Reference 1 name' },
  { key: 'ref1_phone', label: 'Reference 1 phone' },
  { key: 'ref1_relation', label: 'Relationship' },
  { key: 'ref2_name', label: 'Reference 2 name' },
  { key: 'ref2_phone', label: 'Reference 2 phone' },
  { key: 'ref2_relation', label: 'Relationship' },
];

const inputFields = (list) => list.filter((f) => f.key);
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function loadApp(db, customerId) {
  const row = db.prepare('SELECT * FROM credit_apps WHERE customer_id = ?').get(customerId);
  if (!row) return null;
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }
  return { ...row, data, ssn: decrypt(db, row.ssn_enc), co_ssn: decrypt(db, row.co_ssn_enc) };
}

// Pre-fill a new application from what we already know about the customer and their deal.
function prefill(db, customer) {
  const [coFirst, ...coRest] = (customer.co_buyer_name || '').trim().split(/\s+/);
  const deal = db
    .prepare(`
      SELECT d.sale_price, d.discount, i.year, i.manufacturer, i.model, i.stock_number FROM deals d
      JOIN inventory i ON i.id = d.inventory_id WHERE d.customer_id = ? AND d.status != 'cancelled'
      ORDER BY d.id DESC LIMIT 1
    `)
    .get(customer.id);
  const landMap = { owns: 'Land I own', buying: 'Land I am buying', family: 'Family land', community: 'Rented lot / community', looking: 'Undecided' };
  return {
    a_first_name: customer.first_name,
    a_last_name: customer.last_name,
    a_phone: customer.phone,
    a_email: customer.email,
    a_address: customer.address,
    a_city: customer.city,
    a_state: customer.state,
    a_zip: customer.zip,
    c_first_name: coFirst || '',
    c_last_name: coRest.join(' '),
    c_phone: customer.co_buyer_phone,
    c_email: customer.co_buyer_email,
    land_type: landMap[customer.land_status] || '',
    land_address: customer.land_location,
    home_desc: deal ? `${deal.year || ''} ${deal.manufacturer} ${deal.model} — stock #${deal.stock_number}`.trim() : '',
    home_price: deal ? round2(deal.sale_price - deal.discount) : customer.budget || '',
  };
}

// Monthly payment a borrower can afford → the largest loan and home price it supports.
//   income   = applicant + co-applicant gross monthly income (incl. other income)
//   debts    = monthly debt payments (vehicle, cards, other) — not current rent, which the new home replaces
//   extras   = lot rent + estimated insurance: part of the new housing cost, but not financed
//   payment  = min(DTI% × income − debts, PTI% × income) − extras
//   loan     = present value of that payment at the profile's rate and term
//   budget   = loan + down payment, capped so the down payment meets the lender's minimum %
function estimateBudget(data, profile, { insuranceMonthly = 0 } = {}) {
  const income = round2(
    num(data.a_monthly_income) + num(data.a_other_income) + num(data.c_monthly_income) + num(data.c_other_income)
  );
  const debts = round2(
    ['a_debt_auto', 'a_debt_cards', 'a_debt_other', 'c_debt_auto', 'c_debt_cards', 'c_debt_other'].reduce((s, k) => s + num(data[k]), 0)
  );
  const extras = round2(num(data.lot_rent) + insuranceMonthly);
  const down = round2(num(data.down_payment));
  if (!income) return { profile, income, debts, extras, down, payment: 0, loan: 0, maxPrice: 0, incomplete: true };

  const dtiRoom = (profile.dti_max / 100) * income - debts;
  const ptiRoom = profile.pti_max ? (profile.pti_max / 100) * income : Infinity;
  const payment = round2(Math.max(0, Math.min(dtiRoom, ptiRoom) - extras));
  const r = profile.rate / 100 / 12;
  const n = profile.term_months;
  const loan = round2(r ? (payment * (1 - Math.pow(1 + r, -n))) / r : payment * n);
  let maxPrice = round2(loan + down);
  let limitedByDown = false;
  if (profile.min_down_percent > 0) {
    const capByDown = round2(down / (profile.min_down_percent / 100));
    if (capByDown < maxPrice) {
      maxPrice = capByDown;
      limitedByDown = true;
    }
  }
  return {
    profile,
    income,
    debts,
    extras,
    down,
    payment,
    loan,
    maxPrice,
    limitedByDown,
    dti: income ? round2(((debts + payment + extras) / income) * 100) : null,
  };
}

function budgetsFor(db, data) {
  const settings = getSettings(db);
  const insuranceMonthly = num(settings.budget_insurance_monthly);
  const profiles = db.prepare('SELECT * FROM lender_profiles WHERE active = 1 ORDER BY sort, name').all();
  const results = profiles.map((p) => estimateBudget(data || {}, p, { insuranceMonthly }));
  const best = results.filter((r) => !r.incomplete).sort((a, b) => b.maxPrice - a.maxPrice)[0] || null;
  return { results, best, insuranceMonthly };
}

// Max budget for many customers at once (for list pages).
function bestBudgets(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT customer_id, data FROM credit_apps').all()) {
    try {
      const { best } = budgetsFor(db, JSON.parse(row.data));
      if (best) map.set(row.customer_id, best);
    } catch {
      // ignore unreadable rows
    }
  }
  return map;
}

module.exports = { PERSON_FIELDS, PURCHASE_FIELDS, inputFields, loadApp, prefill, estimateBudget, budgetsFor, bestBudgets, num };
