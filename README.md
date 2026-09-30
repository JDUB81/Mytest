# Premier Homes CRM

A simple CRM for the Premier Homes manufactured home sales center: staff sign in, track
inventory, keep customer records, and assign homes to customers.

## Access levels

| Feature | Manager | Sales Associate |
| --- | :---: | :---: |
| Sign in / change own password | ✅ | ✅ |
| Add & edit customers | ✅ | ✅ |
| View inventory (available, pending, sold) | ✅ | ✅ |
| Assign an available home to an existing customer | ✅ | ✅ |
| **Add, edit & delete inventory** | ✅ | ❌ |
| Mark a pending home as sold / release it back to available | ✅ | ❌ |
| Delete customers | ✅ | ❌ |
| Create staff logins, change access levels, disable accounts, reset passwords | ✅ | ❌ |

Home status flow: **Available → (assigned to customer) → Pending sale → Sold**. A manager can
release a pending or sold home back to Available.

## Running it

Requires Node.js 18 or newer.

```bash
npm install
SESSION_SECRET="some-long-random-string" npm start
```

Open http://localhost:3000. The first time, you'll be asked to create the first **Manager**
account. After that, managers add staff under **Staff → New account**.

Data is stored in a SQLite file at `data/premier-homes.db` — back this file up regularly.

### Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `SESSION_SECRET` | Secret for signing login cookies. **Set this in production**, otherwise everyone is signed out on restart |
| `DB_PATH` | Location of the SQLite database file |
| `COOKIE_SECURE=true` | Only send the login cookie over HTTPS (use when served over HTTPS) |
| `TRUST_PROXY=1` | Set when running behind a reverse proxy / load balancer |

### Command-line account recovery

If a manager is locked out:

```bash
npm run create-user -- jon manager "Jon Hunt"   # prompts for a password
```

This creates the account, or resets the password/role if the username already exists.

## Security notes

- Passwords are hashed with bcrypt; minimum length 8.
- 5 failed sign-ins lock that username/IP for 15 minutes.
- All forms are CSRF-protected; login cookies are `HttpOnly` and `SameSite=Lax`.
- Disabling an account or resetting its password signs that person out immediately.

## Development

```bash
npm test
```

Code layout: `src/routes/` (one file per area), `views/` (EJS templates), `public/styles.css`.
