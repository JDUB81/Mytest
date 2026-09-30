const session = require('express-session');

// Minimal express-session store backed by the app's SQLite database,
// so logins survive a server restart without another dependency.
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  }

  expiry(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess));
      if (Math.random() < 0.05) this.pruneStmt.run(Date.now());
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = SqliteStore;
