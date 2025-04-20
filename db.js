// db.js
const { Pool } = require('pg');

const pool = new Pool({
  user: 'shovan',
  host: 'localhost',
  database: 'health_data',
  password: '', // replace this with your actual PostgreSQL password
  port: 5432,
});

{}



module.exports = pool;
