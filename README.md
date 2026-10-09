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

**Public website** (what visitors see at your web address; staff signing in still get the CRM)
- A home page with a featured homes section, a quick search, financing and "how it works" sections, and your phone, hours and address
- Homes for sale, with filters for type, bedrooms, price and lot vs. build-to-order, and an estimated monthly payment
- A page for each home with its photo gallery, specs, description and an "Ask about this home" form
- Online pre-qualification: visitors enter income, payments and down payment and see an estimated budget plus homes that fit. **No credit check**, and nothing is shown that implies a loan approval
- Every website message or pre-qualification becomes a customer (source "Website"), with a note and a call-back task for that customer's salesperson, or the first manager if they have none. Repeat visitors are matched by phone or email, so they aren't duplicated. Pre-qualification answers start the customer's credit application
- Only homes marked **Show on website** that are still available appear. Dealer cost, internal notes, serial numbers and lot locations are never shown. Photos of sold or hidden homes are not public
- Spam protection: a hidden bot-trap field and a limit of 5 submissions per 10 minutes per visitor
- Edit the tagline, hours, service area, "About us" and whether prices show under **Settings → Public website**. Pick featured homes and write descriptions on each home's Edit page

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
- Filters (type, beds, max price, lot vs. build-to-order), sorting, and days-on-lot with a warning after 90 days
- **Load factory models**: one click adds the Destiny Homes / Cavco Moultrie quote (10-1-26) as 11 build-to-order homes. Each is priced at the High Volume price, with cost split into invoice, freight and fees. The High Margin and 21st Mortgage max prices are in the notes

**Deals (sales pricing)**
- Assigning a home to a customer opens a deal at the list price, using the default tax rate and doc fee
- Sale price, discount, add-on line items (delivery & setup, A/C, skirting…; taxable or not), doc fee, sales tax, trade-in allowance and payoff
- Financing type, lender, delivery date and address
- Deposits, payments and refunds, each with a printable receipt; managers can void a payment (reason required)
- Printable buyer's order / quote with signature lines
- Managers mark deals sold, or cancel them. A cancelled deal returns the home to inventory and keeps its history
- Gross profit per deal (**managers only**)

**Credit & max budget**
- Credit application for applicant and co-applicant: personal, residence, employment and income, debts, bankruptcy, purchase, land and references. It pre-fills from the customer record and their deal, and prints as a signed application with an authorization statement
- Social Security numbers are encrypted in the database (key in `data/.field-key`), shown masked as the last 4 digits, and printed in full only on the application (or left blank)
- Max budget per lender: (max DTI % × household income) − monthly debts − lot rent − insurance estimate → max payment → max loan at the lender's rate and term → + down payment. Optional payment-to-income and minimum-down limits. Lender rules are editable under **Settings → Lender rules** (starting values for 21st and Triad are estimates)
- In-stock homes that fit the customer's max budget (and bedrooms wanted)
- Lender submission tracking (submitted, conditional, approved, declined…) with amount, rate, term, payment and conditions; the customer's stage updates automatically
- Document checklist (ID, paystubs, bank statements, land deed…) with who received what and when

**Books: check writing & job costs (managers only)**
- One **Jobs & add-ons** list (Settings or Books): setup, HVAC, skirting, decks, utilities, permits and more, grouped by category, each with a price, allotted cost and default vendor. Picking a job on a deal fills in price and cost (both stay editable on that deal), and paying for the job pre-selects its vendor
- Write checks to vendors, staff or anyone else. For a deal, pick the job (e.g. Central A/C) and see what's allotted, already paid and remaining, with a live warning if you're going over
- Print checks (amount in words, check-on-top layout with two record stubs); check numbers count up automatically
- Job costs on every deal: allotted vs. paid per job, actual gross profit, and a list of every deal with any over-budget jobs highlighted
- Vendors with payment history; check register filterable by month, category and payee; overhead categories (rent, utilities, advertising…)
- Monthly profit & loss: sales, gross profit, over-budget job costs, salesperson commissions, overhead, net profit

**Expenses & month close (bookkeeping)**
- A chart of accounts that follows the Hartsville P&L: advertising, insurance, lot rent, property tax, payroll, utilities, software and more, plus income lines such as manufacturer reimbursements and tires & axles buyback. Each account has a monthly budget, and recurring accounts are flagged
- **Enter this month's expenses** on one screen: one row per account, with payee, check # and memo
- A year grid shows every account by month against its budget (red = over), with totals, averages and the Hartsville 2023 monthly average for comparison
- **Month close** checklist: are all recurring bills in, and are all deal jobs paid? Then close the month. A closed month locks in the GM's commission for that month
- The profit & loss uses these accounts: overhead = expenses − income lines

**Commission ledgers**
- Each staff member has a plan:
  - **Jon Wayne pay scale** (the default for new salespeople): one rate on the whole deal's profit. Singles: 10%, 18% from $10k profit, 20% from $13k. Doubles: 10%, 18% from $10k, 20% from $20k, 25% from $30k. Deals under the minimum profit ($9,000 single / $15,000 double) are flagged for manager approval. Edit the tiers under **Settings → Pay scale**
  - **Salesperson flat %** (default 25% of each deal's gross profit)
  - **General manager** (default 35% of the lot's net profit for each completed month)
  - Rates can differ per person
- When checks for a job go over its allotted cost, the commission is recalculated on the lower profit and the difference is charged back to the salesperson's balance, which comes off future commissions
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

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. The first time, you'll be asked to create the first **Manager**
account. After that, managers add staff under **Staff → New account**, and should fill in
**Settings** (business info, tax rate, doc fee).

Everything lives in the `data` folder: the database (`premier-homes.db`), photos (`uploads/`) and
the encryption key for Social Security numbers (`.field-key`). **Back up the whole `data` folder**
regularly. **Settings → Download backup** saves the database only; without `.field-key`, SSNs in a
restored backup can't be read. When you install a new version, the
database is upgraded automatically on startup.

### Putting it online

To reach the CRM from anywhere, it has to run on a server with HTTPS. Send your hosting
provider **[HOSTING.md](HOSTING.md)**: it lists exactly what the server needs and how to install,
run, back up and update it.

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
- Photos are only served to signed-in staff, except photos of homes listed on the public website.
- CSV exports neutralize spreadsheet formulas in text fields.

## Development

```bash
npm test
```

Code layout: `src/routes/` (one file per area), `src/deals.js` (deal math shared by pages, printouts and reports),
`src/db.js` (schema and versioned migrations: add a new migration, never edit a shipped one),
`views/` (EJS templates), `public/` (CSS and a small script).
