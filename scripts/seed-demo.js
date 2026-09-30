#!/usr/bin/env node
// Fills a SEPARATE demo database with realistic sample data so you can try
// every feature without touching real records.
//   npm run demo        → seeds data/demo.db (if empty) and starts the app on it (see scripts/demo.js)
// Demo logins: manager / demo-manager   and   sales / demo-sales1
const path = require('path');
const { openDatabase } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { today } = require('../src/deals');

function seedDemo(file) {
  if (path.basename(file) === 'premier-homes.db') {
    throw new Error('Refusing to seed demo data into the real database. Use a different DB_PATH.');
  }
  const db = openDatabase(file);

  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) {
    console.log(`Demo database already has data: ${file}`);
    db.close();
    return;
  }

  // Timestamp N days ago in SQLite's UTC format.
  const ago = (days, hour = 15) => {
    const d = new Date(Date.now() - days * 86400000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };

  db.transaction(() => {
    const user = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)');
    const mgr = user.run('manager', 'Morgan Blake', hashPassword('demo-manager'), 'manager').lastInsertRowid;
    const s1 = user.run('sales', 'Riley Carter', hashPassword('demo-sales1'), 'sales').lastInsertRowid;
    const s2 = user.run('sales2', 'Jamie Ortiz', hashPassword('demo-sales2'), 'sales').lastInsertRowid;

    const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    setting.run('business_name', 'Premier Homes');
    setting.run('business_address', '1200 Highway 69 South\nTyler, TX 75703');
    setting.run('business_phone', '(903) 555-0142');
    setting.run('business_email', 'sales@premierhomes.example');
    setting.run('default_tax_rate', '5.25');
    setting.run('default_doc_fee', '295');
    setting.run('commission_percent', '20');

    const home = db.prepare(`
      INSERT INTO inventory (stock_number, manufacturer, model, year, home_type, serial_number, bedrooms, bathrooms,
        square_feet, width_ft, length_ft, price, invoice_cost, freight_cost, other_cost, location, exterior_color,
        features, arrival_date, created_by, created_at)
      VALUES (@stock, @mfr, @model, @year, @type, @serial, @beds, @baths, @sqft, @w, @l, @price, @cost, @freight, @other,
        @loc, @color, @features, @arrival, ${mgr}, @created)
    `);
    const homes = [
      ['PH-1001', 'Clayton', 'The Anniversary', 2026, 'Double-wide', 3, 2, 1568, 28, 56, 94900, 68200, 3100, 1200, 'Lot 1', 'Gray lap siding, white trim', 'Kitchen island, walk-in shower, vaulted ceilings, 2x6 exterior walls', 140],
      ['PH-1002', 'Champion', 'Aspen 16', 2025, 'Single-wide', 2, 1, 980, 16, 66, 58500, 41000, 2400, 800, 'Lot 2', 'Beige vinyl', 'Energy Star package, stainless appliances', 95],
      ['PH-1003', 'Cavco', 'Riverside', 2026, 'Triple-wide', 4, 3, 2280, 42, 60, 139900, 101500, 4800, 2000, 'Lot 3', 'Stone-look skirting, blue siding', 'Fireplace, bonus room, farmhouse sink, 9ft ceilings', 60],
      ['PH-1004', 'Clayton', 'Tempo Bliss', 2026, 'Single-wide', 3, 2, 1216, 16, 76, 72900, 52100, 2400, 900, 'Lot 4', 'White with black shutters', 'Open floor plan, pantry', 34],
      ['PH-1005', 'Fleetwood', 'Berkshire', 2025, 'Double-wide', 4, 2, 1904, 28, 68, 109500, 79900, 3100, 1200, 'Lot 5', 'Sage green', 'Den, laundry room, tile backsplash', 21],
      ['PH-1006', 'Live Oak', 'The Hacienda', 2026, 'Double-wide', 3, 2, 1493, 28, 52, 89900, null, 3100, null, 'Lot 6', 'Tan stucco look', 'Covered porch package', 9],
      ['PH-1007', 'Champion', 'Genesis', 2026, 'Modular', 3, 2.5, 1780, 30, 60, 149500, 112000, 5200, 2500, 'Model center', 'Craftsman, gray/white', 'Two-story model, garage-ready, quartz counters', 4],
      ['PH-1008', 'Skyline', 'Cottage 1 Bed', 2025, 'Park model', 1, 1, 399, 12, 34, 44900, 31200, 1500, 500, 'Lot 7', 'Barn red', 'Loft, porch', 118],
    ];
    const ids = {};
    homes.forEach((h, i) => {
      ids[h[0]] = home.run({
        stock: h[0], mfr: h[1], model: h[2], year: h[3], type: h[4], beds: h[5], baths: h[6], sqft: h[7], w: h[8], l: h[9],
        price: h[10], cost: h[11], freight: h[12], other: h[13], loc: h[14], color: h[15], features: h[16],
        serial: `TX${100200 + i * 17}AB`, arrival: today(-h[17]), created: ago(h[17]),
      }).lastInsertRowid;
    });

    const cust = db.prepare(`
      INSERT INTO customers (first_name, last_name, phone, email, address, city, state, zip, lead_status, lead_source,
        salesperson_id, budget, desired_bedrooms, land_status, land_location, financing_pref, preferred_contact,
        follow_up_date, co_buyer_name, co_buyer_phone, notes, created_by, created_at)
      VALUES (@first, @last, @phone, @email, @addr, @city, 'TX', @zip, @stage, @source, @sp, @budget, @beds, @land, @landloc,
        @fin, @pref, @follow, @co, @cophone, @notes, @sp, @created)
    `);
    const people = [
      ['Jordan', 'Rivera', 'under_contract', 'Facebook', s1, 95000, 3, 'owns', '5 acres off FM 2767', 'chattel', 'Text', null, 'Taylor Rivera', 'Wants move-in before Christmas.', 40],
      ['Casey', 'Nguyen', 'closed', 'Referral', s1, 60000, 2, 'family', "Parents' land in Whitehouse", 'cash', 'Phone call', null, null, 'Paid cash; referred by the Lopez family.', 70],
      ['Avery', 'Thompson', 'approved', 'Website', s2, 140000, 4, 'buying', 'Closing on 3 acres in Lindale', 'land_home', 'Email', 0, 'Sam Thompson', 'Pre-approved with 21st Mortgage, shopping triple-wides.', 18],
      ['Morgan', 'Lee', 'appointment', 'Drive-by / sign', s2, 75000, 3, 'community', 'Needs lot at Pine Grove', 'chattel', 'Phone call', 1, null, 'Coming Saturday 10am with spouse.', 6],
      ['Drew', 'Patel', 'contacted', 'Google', s1, 110000, 4, 'owns', 'Bullard', 'fha', 'Text', -2, null, 'Credit around 640, asked about FHA.', 12],
      ['Quinn', 'Martinez', 'new', 'Walk-in', null, 50000, 2, 'looking', null, null, null, 0, null, 'Browsing single-wides.', 1],
      ['Hayden', 'Brooks', 'application', 'Lender referral', s2, 90000, 3, 'owns', 'Chandler', 'chattel', 'Phone call', 3, null, 'Credit app submitted to Triad.', 9],
      ['Reese', 'Coleman', 'lost', 'Facebook', s1, 70000, 3, 'looking', null, 'chattel', 'Text', null, null, 'Bought elsewhere.', 55],
      ['Skyler', 'Adams', 'closed', 'Repeat customer', s2, 115000, 4, 'owns', 'Flint', 'land_home', 'Email', null, 'Pat Adams', 'Second home purchase.', 35],
    ];
    const cids = {};
    people.forEach((p, i) => {
      cids[p[1]] = cust.run({
        first: p[0], last: p[1], stage: p[2], source: p[3], sp: p[4], budget: p[5], beds: p[6], land: p[7], landloc: p[8],
        fin: p[9], pref: p[10], follow: p[11] === null ? null : today(p[11]), co: p[12], cophone: p[12] ? '(903) 555-01' + (40 + i) : null,
        notes: p[13], phone: `(903) 555-0${100 + i * 7}`, email: `${p[0].toLowerCase()}.${p[1].toLowerCase()}@example.com`,
        addr: `${100 + i * 12} Oak St`, city: ['Tyler', 'Whitehouse', 'Lindale', 'Bullard'][i % 4], zip: '757' + (10 + i),
        created: ago(p[14]),
      }).lastInsertRowid;
    });

    const deal = db.prepare(`
      INSERT INTO deals (customer_id, inventory_id, salesperson_id, status, sale_price, discount, tax_rate, doc_fee,
        financing_type, lender, delivery_date, delivery_address, created_by, created_at, sold_at, trade_description,
        trade_allowance, trade_payoff)
      VALUES (@c, @h, @sp, @status, @price, @discount, 5.25, 295, @fin, @lender, @delivery, @addr, @sp, @created, @sold,
        @tradeDesc, @trade, @payoff)
    `);
    const item = db.prepare('INSERT INTO deal_items (deal_id, description, price, cost, taxable) VALUES (?, ?, ?, ?, ?)');
    const pay = db.prepare(`
      INSERT INTO payments (deal_id, kind, amount, method, reference, received_on, received_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const claim = db.prepare('UPDATE inventory SET customer_id = ?, assigned_by = ?, assigned_at = ?, status = ? WHERE id = ?');
    const act = db.prepare('INSERT INTO activity (user_id, customer_id, inventory_id, deal_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)');

    function makeDeal({ customer, stock, sp, status, price, discount = 0, fin, lender, openedDaysAgo, soldDaysAgo, items, payments, trade }) {
      const id = deal.run({
        c: cids[customer], h: ids[stock], sp, status, price, discount, fin, lender,
        delivery: status === 'sold' ? today(-soldDaysAgo + 21) : today(30), addr: null,
        created: ago(openedDaysAgo), sold: soldDaysAgo !== undefined ? ago(soldDaysAgo) : null,
        tradeDesc: trade ? trade[0] : null, trade: trade ? trade[1] : 0, payoff: trade ? trade[2] : 0,
      }).lastInsertRowid;
      claim.run(cids[customer], sp, ago(openedDaysAgo), status, ids[stock]);
      for (const it of items) item.run(id, ...it);
      for (const p of payments) pay.run(id, p[0], p[1], p[2], p[3], today(-p[4]), sp, ago(p[4]));
      act.run(sp, cids[customer], ids[stock], id, `Assigned stock #${stock} to ${customer} (deal opened)`, ago(openedDaysAgo));
      if (soldDaysAgo !== undefined) act.run(mgr, cids[customer], ids[stock], id, 'Marked sold', ago(soldDaysAgo));
      return id;
    }

    makeDeal({
      customer: 'Rivera', stock: 'PH-1001', sp: s1, status: 'pending', price: 94900, discount: 1500, fin: 'chattel',
      lender: 'Triad Financial', openedDaysAgo: 6,
      items: [['Delivery & setup', 6500, 4200, 1], ['Central A/C', 4200, 2900, 1], ['Vinyl skirting', 2100, 1100, 1], ['Steps (2)', 900, 450, 1]],
      payments: [['deposit', 2500, 'check', '#1042', 6]],
    });
    makeDeal({
      customer: 'Nguyen', stock: 'PH-1002', sp: s1, status: 'sold', price: 57500, fin: 'cash', lender: null,
      openedDaysAgo: 40, soldDaysAgo: 26,
      items: [['Delivery & setup', 4800, 3100, 1], ['Permits', 450, 450, 0]],
      payments: [['deposit', 5000, 'card', 'Visa 4421', 40], ['payment', 61315.75, 'wire', 'Wire 88213', 26]],
    });
    makeDeal({
      customer: 'Adams', stock: 'PH-1005', sp: s2, status: 'sold', price: 107500, discount: 0, fin: 'land_home',
      lender: 'Vanderbilt Mortgage', openedDaysAgo: 30, soldDaysAgo: 3,
      items: [['Delivery & setup', 7200, 4900, 1], ['Heat pump', 5600, 3900, 1], ['Deck 10x12', 3200, 1800, 1]],
      payments: [['deposit', 3000, 'check', '#5510', 30], ['payment', 122148.75, 'lender', 'Vanderbilt funding', 3]],
      trade: ['2004 Fleetwood single-wide', 12000, 7500],
    });

    const note = db.prepare('INSERT INTO notes (customer_id, inventory_id, deal_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    note.run(cids.Rivera, null, null, s1, 'visit', 'Toured the Anniversary and Tempo Bliss. Loves the kitchen island in the Anniversary.', ago(8));
    note.run(cids.Rivera, null, null, s1, 'call', 'Confirmed land has septic and water; survey done last year.', ago(7));
    note.run(cids.Rivera, ids['PH-1001'], 1, s1, 'note', 'Triad needs 2 recent paystubs and proof of land ownership.', ago(5));
    note.run(cids.Lee, null, null, s2, 'call', 'Set appointment for Saturday 10am. Bringing spouse.', ago(2));
    note.run(cids.Patel, null, null, s1, 'text', 'Sent FHA info and floor plans for Berkshire and Riverside.', ago(4));
    note.run(cids.Thompson, null, null, s2, 'email', 'Sent pre-approval checklist; closing on land in 2 weeks.', ago(3));
    note.run(null, ids['PH-1008'], null, mgr, 'note', 'Minor scuff on front door — touch up before showing.', ago(20));

    const task = db.prepare('INSERT INTO tasks (title, due_date, customer_id, assigned_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    task.run('Collect paystubs for Triad', today(), cids.Rivera, s1, s1, ago(5));
    task.run('Call Drew about FHA pre-qual', today(-1), cids.Patel, s1, mgr, ago(3));
    task.run('Order skirting for Rivera home', today(2), cids.Rivera, mgr, mgr, ago(4));
    task.run('Confirm Saturday appointment', today(1), cids.Lee, s2, s2, ago(2));
    task.run('Touch up PH-1008 front door', today(-3), null, mgr, mgr, ago(20));
  })();

  db.close();
  console.log(`Demo data created in ${file}`);
}

module.exports = { seedDemo };

if (require.main === module) {
  seedDemo(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db'));
}
