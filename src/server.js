const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDatabase, defaultDbPath } = require('./db');
const { createApp } = require('./app');

// Use SESSION_SECRET if given; otherwise create one next to the database and reuse
// it, so logins survive restarts without any setup.
function sessionSecret(dbFile) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(dbFile), '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_PATH || defaultDbPath();
const db = openDatabase(dbFile);
const app = createApp(db, { sessionSecret: sessionSecret(dbFile) });

app.listen(port, () => {
  console.log(`Premier Homes CRM running at http://localhost:${port}`);
  console.log('Press Ctrl+C to stop.');
});
