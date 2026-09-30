# Premier Homes CRM

A CRM for the Premier Homes manufactured home sales center: track leads and customers, manage
lot inventory, work deals with full pricing, take deposits, print buyer's orders, and see how
the business is doing.

## Try it with sample data

```bash
npm install
npm run demo
```

Open http://localhost:3000 and sign in as **manager / demo-manager** or **sales / demo-sales1**.
The demo uses its own database (`data/demo.db`), separate from your real one.

## Features

**Customers & leads**
- Lead pipeline: New → Contacted → Appointment → Credit application → Approved → Under contract → Closed / Lost
- Lead source, assigned salesperson, budget, bedrooms wanted, land situation, financing preference, co-buyer, preferred contact
- Notes history (note / call / text / email / visit), plus an automatic timeline of everything that happened
- Follow-up dates with one-click "tomorrow / 3 days / 1 week" buttons; due follow-ups show on the dashboard
- Tasks assigned to any staff member, optionally linked to a customer, with overdue highlighting

**Inventory**
- Stock #, serial/VIN, make/model/year, type, beds/baths, sq ft, dimensions, colors, features, lot location, arrival date
- Photo gallery per home
- Dealer cost (invoice, freight, other): **managers only**
- Filters (type, beds, max price), sorting, and days-on-lot with a warning after 90 days

**Deals (sales pricing)**
- Assigning a home to a customer opens a deal at the list price, using the default tax rate and doc fee
- Sale price, discount, add-on line items (delivery & setup, A/C, skirting…; taxable or not), doc fee, sales tax, trade-in allowance and payoff
- Financing type, lender, delivery date and address
- Deposits, payments and refunds, each with a printable receipt; managers can void a payment (reason required)
- Printable buyer's order / quote with signature lines
- Managers mark deals sold, or cancel them. A cancelled deal returns the home to inventory and keeps its history
- Gross profit per deal (**managers only**)

**Books: check writing & job costs (managers only)**
- Add-on price list: preset price and allotted cost for each option. Picking one on a deal fills both in, and both stay editable
- Write checks to vendors, staff or anyone else. For a deal, pick the job (e.g. Central A/C) and see what's allotted, already paid and remaining, with a live warning if you're going over
- Print checks (amount in words, check-on-top layout with two record stubs); check numbers count up automatically
- Job costs on every deal: allotted vs. paid per job, actual gross profit, and a list of every deal with any over-budget jobs highlighted
- Vendors with payment history; check register filterable by month, category and payee; overhead categories (rent, utilities, advertising…)
- Monthly profit & loss: sales, gross profit, over-budget job costs, salesperson commissions, overhead, net profit

**Commission ledgers**
- Each staff member has a plan: **Salesperson** (default 25% of each deal's gross profit, earned when the deal is sold) or **General manager** (default 35% of the lot's net profit for each completed month). Rates can differ per person
- When checks for a job go over its allotted cost, the salesperson's rate × the overrun is charged back to their balance, which comes off future commissions
- A general manager's closed month is recalculated if it changes later, and the difference is posted to their balance
- Pay commissions by check from the ledger; voiding a check restores the balance. Manual adjustments need a reason
- Salespeople see their own ledger under **My commission** (no profit figures shown)

**Management (managers only)**
- Reports: homes sold, sales, gross profit, commission by salesperson, money collected, 12-month trend, lead-source close rates, pipeline, inventory aging
- CSV exports of customers, inventory, sales and payments (open in Excel or Google Sheets)
- Settings: business name, address and phone for printouts, default tax rate, doc fee, commission %, deposit terms
- Activity log of every change, and a one-click database backup download

**Everywhere:** a dashboard, global search (name, phone, email, stock #, serial, deal #), and a layout that works on phones.

## Access levels

| | Manager | Sales Associate |
| --- | :---: | :---: |
| Customers, notes, tasks, follow-ups | ✅ | ✅ |
| View inventory and photos | ✅ | ✅ |
| Assign a home to a customer (opens a deal) | ✅ | ✅ |
| Price a **pending** deal, add add-ons, take deposits and payments, print documents | ✅ | ✅ |
| **Add/edit/delete inventory and photos** | ✅ | ❌ |
| See dealer cost and gross profit | ✅ | ❌ |
| Mark a deal sold, cancel a deal, record refunds, void payments, edit sold deals | ✅ | ❌ |
| Delete customers | ✅ | ❌ |
| Reports, exports, settings, activity log, backups | ✅ | ❌ |
| Books: checks, vendors, job costs, P&L, commission ledgers, price list | ✅ | ❌ |
| See own commission ledger | ✅ | ✅ |
| Staff logins and access levels | ✅ | ❌ |

## Running it for real

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. The first time, you'll be asked to create the first **Manager**
account. After that, managers add staff under **Staff → New account**, and should fill in
**Settings** (business info, tax rate, doc fee).

Data lives in `data/premier-homes.db` and photos in `data/uploads/`. Use **Settings → Download
backup** regularly, and back up the uploads folder too. When you install a new version, the
database is upgraded automatically on startup.

### Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `SESSION_SECRET` | Secret for signing login cookies. Optional: if unset, one is generated and saved to `data/.session-secret` |
| `DB_PATH` | Location of the SQLite database file |
| `UPLOAD_DIR` | Where photos are stored (default `data/uploads`) |
| `COOKIE_SECURE=true` | Only send the login cookie over HTTPS (use when served over HTTPS) |
| `TRUST_PROXY=1` | Set when running behind a reverse proxy / load balancer |

### Command-line account recovery

If a manager is locked out:

```bash
npm run create-user -- jon manager "Jon Hunt"   # prompts for a password
```

This creates the account, or resets the password and role if the username already exists.

## Security notes

- Passwords are hashed with bcrypt, with a minimum length of 8.
- 5 failed sign-ins lock that username/IP for 15 minutes.
- All forms are CSRF-protected. Login cookies are `HttpOnly` and `SameSite=Lax`.
- Disabling an account or resetting its password signs that person out immediately.
- Photos are only served to signed-in staff.
- CSV exports neutralize spreadsheet formulas in text fields.

## Development

```bash
npm test
```

Code layout: `src/routes/` (one file per area), `src/deals.js` (deal math shared by pages, printouts and reports),
`src/db.js` (schema and versioned migrations: add a new migration, never edit a shipped one),
`views/` (EJS templates), `public/` (CSS and a small script).
