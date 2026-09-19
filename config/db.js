const path = require('path');
const fs = require('fs');

// Try multiple .env locations across deployment directories
const candidates = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '../.env'),
];

for (const p of candidates) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
  }
}
require('dotenv').config();

const { Sequelize } = require('sequelize');

const dbName = process.env.DB_NAME || process.env.DB_DATABASE || '';
const dbUser = process.env.DB_USER || process.env.DB_USERNAME || '';
const dbPass = process.env.DB_PASS !== undefined ? process.env.DB_PASS : (process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '');
let dbHost = process.env.DB_HOST || '127.0.0.1';

// Convert 'localhost' to IPv4 '127.0.0.1' to prevent Node 18+ from attempting IPv6 (::1) connection
if (dbHost === 'localhost') {
  dbHost = '127.0.0.1';
}

if (!dbUser || !dbName) {
  console.error("❌ CRITICAL ERROR: DB_USER or DB_NAME is missing in environment variables!");
  console.error("Please ensure .env file is uploaded to Hostinger or environment variables are set in hPanel.");
}

const sequelize = new Sequelize(
  dbName,
  dbUser,
  dbPass,
  {
    host: dbHost,
    dialect: 'mysql',
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    logging: false, // Disable logging for production performance
  }
);

exports.sequelize = sequelize;