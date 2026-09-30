#!/usr/bin/env node
// Starts the app on a separate demo database filled with sample data.
const path = require('path');
const { seedDemo } = require('./seed-demo');

const dataDir = path.join(__dirname, '..', 'data');
process.env.DB_PATH = path.join(dataDir, 'demo.db');
process.env.UPLOAD_DIR = path.join(dataDir, 'demo-uploads');

seedDemo(process.env.DB_PATH);
console.log('');
console.log('DEMO MODE: sample data only. Sign in with');
console.log('  manager / demo-manager   (Manager)');
console.log('  sales   / demo-sales1    (Sales Associate)');
console.log('');
require('../src/server');
