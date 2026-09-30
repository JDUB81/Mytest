// Field-level encryption for the most sensitive data (Social Security numbers).
//
// The key lives in a file next to the database (".field-key"), not in the database
// itself, so a copied or stolen database file alone doesn't reveal SSNs. Back up the
// key file together with the database, or encrypted SSNs can't be read after a restore.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const keys = new WeakMap();

function keyFor(db) {
  if (keys.has(db)) return keys.get(db);
  let key;
  if (process.env.FIELD_KEY) {
    key = crypto.createHash('sha256').update(process.env.FIELD_KEY).digest();
  } else if (db.memory || !db.name || db.name === ':memory:') {
    key = crypto.randomBytes(32);
  } else {
    const file = path.join(path.dirname(db.name), '.field-key');
    try {
      key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
      if (key.length !== 32) throw new Error('bad key');
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Encryption key ${file} is unreadable: ${err.message}`);
      key = crypto.randomBytes(32);
      fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    }
  }
  keys.set(db, key);
  return key;
}

function encrypt(db, plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(db), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(db, stored) {
  if (!stored) return null;
  try {
    const [, iv, tag, data] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(db), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key (e.g. restored without .field-key)
  }
}

// "123456789" → "123-45-6789"; anything that isn't 9 digits → null.
function normalizeSsn(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : null;
}

const maskSsn = (ssn) => (ssn ? `•••-••-${ssn.slice(-4)}` : '');

module.exports = { encrypt, decrypt, normalizeSsn, maskSsn };
