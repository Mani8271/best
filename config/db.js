const path = require('path');
const fs = require('fs');

const envPathRoot = path.join(__dirname, '../.env');
const envPathCwd = path.join(process.cwd(), '.env');

if (fs.existsSync(envPathRoot)) {
  require('dotenv').config({ path: envPathRoot });
} else if (fs.existsSync(envPathCwd)) {
  require('dotenv').config({ path: envPathCwd });
} else {
  require('dotenv').config();
}

const { Sequelize } = require('sequelize');

const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASS;
const dbHost = process.env.DB_HOST || 'localhost';

if (!dbUser || !dbName) {
  console.error("❌ CRITICAL ERROR: DB_USER or DB_NAME is missing in environment variables!");
  console.error("Please ensure .env file is uploaded to Hostinger or environment variables are set in hPanel.");
}

const sequelize = new Sequelize(
  dbName || '',
  dbUser || '',
  dbPass || '',
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