# Hosting Premier Homes CRM

This document is for whoever hosts the CRM. It's a small, self-contained web app:
**Node.js + Express**, with an **SQLite** database stored in a local folder. No separate
database server, email service or other external services are needed.

## What the server needs

| | |
| --- | --- |
| Runtime | **Node.js 22 or newer** that runs as a **long-lived process** (not PHP-only shared hosting) |
| Disk | A **persistent, writable** folder for data (starts under 50 MB; grows with photos) |
| Memory | ~150 MB RAM is plenty |
| Network | HTTPS on a (sub)domain, e.g. `crm.premierhomes.com`, reverse-proxied to the app's port |
| Build | `npm install` compiles/downloads one native module (`better-sqlite3`). A prebuilt binary normally downloads automatically; otherwise it needs `python3`, `make` and a C++ compiler |
| Instances | **Exactly one** app instance (SQLite + in-process login throttling). No load balancing across multiple copies |

Works on: a small VPS (Ubuntu/Debian), cPanel/Plesk hosting with a **"Setup Node.js App"**
(Phusion Passenger) feature, Docker hosts, Render/Railway/Fly.io with a persistent volume.
It will **not** work on hosting that only serves static files or PHP.

## Install

```bash
git clone -b claude/premier-homes-crm-roles-9akdze https://github.com/JDUB81/Mytest.git premier-crm
cd premier-crm
npm ci --omit=dev
```

(Or unzip the release archive the owner sends you, then `npm ci --omit=dev`.)

## Configure (environment variables)

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `PORT` | e.g. `3000` | Port the app listens on (behind your proxy) |
| `DB_PATH` | e.g. `/var/lib/premier-crm/premier-homes.db` | **Put data outside the code folder** so updates never touch it |
| `UPLOAD_DIR` | e.g. `/var/lib/premier-crm/uploads` | Home photos |
| `COOKIE_SECURE` | `true` | Login cookie only sent over HTTPS |
| `TRUST_PROXY` | `1` | Required behind nginx/Apache/Passenger/a load balancer so HTTPS and client IPs are detected |
| `SESSION_SECRET` | optional long random string | If unset, one is generated and saved beside the database |

The data folder (the directory containing `DB_PATH`) will hold:

- `premier-homes.db` (+ `-wal`, `-shm` while running): all business data
- `.session-secret`: login cookie signing key (auto-created)
- `.field-key`: **encryption key for customers' Social Security numbers** (auto-created).
  Losing it makes stored SSNs unreadable. Treat it like a password.
- `uploads/` (if `UPLOAD_DIR` is inside it): photos

The folder must be writable by the app's user and **not** served by the web server.

## Run

```bash
npm start            # = node src/server.js
```

Keep it running with your usual tool: systemd, pm2, Passenger, or Docker. Example systemd unit:

```ini
[Unit]
Description=Premier Homes CRM
After=network.target

[Service]
User=premiercrm
WorkingDirectory=/opt/premier-crm
Environment=NODE_ENV=production PORT=3000 COOKIE_SECURE=true TRUST_PROXY=1
Environment=DB_PATH=/var/lib/premier-crm/premier-homes.db UPLOAD_DIR=/var/lib/premier-crm/uploads
ExecStart=/usr/bin/node src/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Example nginx site (HTTPS via Let's Encrypt/certbot):

```nginx
server {
  server_name crm.premierhomes.com;
  client_max_body_size 50m;          # photo uploads (up to 15 MB each, several at once)
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  listen 443 ssl;  # managed by certbot
}
```

Health check for monitoring: `GET /healthz` returns `ok` (no login needed).

### Docker alternative

A `Dockerfile` and `docker-compose.yml` are included. Data lives in the `crm-data` volume:

```bash
docker compose up -d --build
```

Put your HTTPS proxy in front of port 3000.

## First run

- **New install:** open the site and create the first Manager account on the setup screen.
- **Moving an existing install:** stop the app, then copy the owner's entire existing `data`
  folder contents (`premier-homes.db`, `.session-secret`, `.field-key`, `uploads/`) into the
  data folder **before** first start. Copy it securely (it contains customer personal data).

## Backups (important)

Back up the whole data folder at least daily, keeping several days of copies off the server.
Take a consistent database copy while running with:

```bash
sqlite3 /var/lib/premier-crm/premier-homes.db ".backup '/backups/premier-$(date +%F).db'"
```

and copy `.field-key`, `.session-secret` and `uploads/` alongside it.

## Updating to a new version

```bash
cd /opt/premier-crm && git pull && npm ci --omit=dev && systemctl restart premier-crm
```

Database changes are applied automatically at startup. Take a backup first.

## Security notes

- The app stores customer personal and financial information, including encrypted SSNs.
  Keep the OS and Node.js patched, and restrict SSH access.
- HTTPS is required (`COOKIE_SECURE=true`); do not expose the Node port directly to the internet.
- The app itself handles logins, roles, CSRF protection, and login lockout after 5 failed tries.
