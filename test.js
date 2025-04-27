import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3005; // Using a different port than your main server

// Database configuration
const pool = new pg.Pool({
  user: 'shovan',
  host: 'localhost',
  database: 'health_data',
  password: '',
  port: 5432,
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main data endpoint
app.get('/api/health-data', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT json_build_object(
        'sleep_analysis', (
          SELECT COALESCE(json_agg(row_to_json(sa)), '[]')
          FROM sleep_analysis sa
          WHERE sa.record_date = CURRENT_DATE
        ),
        'health_aggregated', (
          SELECT COALESCE(json_agg(row_to_json(ha)), '[]')
          FROM health_aggregated ha
          WHERE ha.timestamp >= NOW() - INTERVAL '3 hour'
        ),
        'health_realtime', (
          SELECT COALESCE(json_agg(row_to_json(hr)), '[]')
          FROM health_realtime hr
          WHERE hr.timestamp >= NOW() - INTERVAL '3 hour'
        ),
        'mental_health', (
          SELECT COALESCE(json_agg(row_to_json(mh)), '[]')
          FROM mental_health mh
          WHERE mh.logged_at >= NOW() - INTERVAL '3 hour'
        )
      ) AS all_data`;

    const result = await client.query(query);
    const data = result.rows[0].all_data;

    // Add summary counts to the response
    const summary = {
      sleep_analysis_count: data.sleep_analysis.length,
      health_aggregated_count: data.health_aggregated.length,
      health_realtime_count: data.health_realtime.length,
      mental_health_count: data.mental_health.length
    };

    res.json({
      summary,
      data
    });

  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch health data',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Test API server running on http://localhost:${PORT}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  pool.end();
  process.exit(0);
});
