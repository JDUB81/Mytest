#!/usr/bin/env node
// Create or reset a staff account from the command line.
// Usage: npm run create-user -- <username> <manager|sales> "<Full Name>"
// The password is read from the NEW_PASSWORD environment variable or prompted for.
const readline = require('readline');
const { openDatabase, ROLES } = require('../src/db');
const { hashPassword, passwordProblem } = require('../src/auth');

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

async function main() {
  const [username, role, fullName] = process.argv.slice(2);
  if (!username || !ROLES[role]) {
    console.error('Usage: npm run create-user -- <username> <manager|sales> "<Full Name>"');
    process.exit(1);
  }
  const password = process.env.NEW_PASSWORD || (await prompt('Password: '));
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const db = openDatabase();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(
      hashPassword(password),
      role,
      existing.id
    );
    console.log(`Updated ${username} (${ROLES[role]}).`);
  } else {
    db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)').run(
      username,
      fullName || username,
      hashPassword(password),
      role
    );
    console.log(`Created ${username} (${ROLES[role]}).`);
  }
}

main();
