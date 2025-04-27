import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Parser } from 'json2csv';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import pg from 'pg';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import http from 'http';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer();

// Create HTTP server instance
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('error', console.error);
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Add middleware first
app.use(cors({
  origin: 'http://localhost:3000', // Your React app's URL - must be explicit
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));  // Make sure you have cors package installed
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

// Then add routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const queries = {
  respiratoryRate: {
    current: `
      SELECT 
        ROUND(value)::integer as current_resp_rate,
        timestamp as reading_time
      FROM health_realtime
      WHERE metric_name = 'respiratory_rate'
      ORDER BY timestamp DESC
      LIMIT 1
    `,
    dailyAverage: `
      SELECT 
        ROUND(COALESCE(AVG(value), 0))::integer as avg_resp_rate_today
      FROM health_realtime
      WHERE metric_name = 'respiratory_rate'
        AND timestamp::date = CURRENT_DATE
    `
  },
  daylight: {
    weekly: `
      WITH today_daylight AS (
        SELECT COALESCE(SUM(value), 0)::int AS time_in_daylight_today
        FROM health_aggregated
        WHERE metric_name = 'time_in_daylight'
          AND timestamp::date = CURRENT_DATE
      ),
      daily_daylight AS (
        SELECT
          timestamp::date                AS day,
          SUM(value)                     AS total_daylight_minutes
        FROM health_aggregated
        WHERE metric_name = 'time_in_daylight'
          AND timestamp::date >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY 1
      ),
      weekly_avg AS (
        SELECT
          COALESCE(AVG(total_daylight_minutes), 0)::int AS avg_time_in_daylight_7d
        FROM daily_daylight
      )
      SELECT 
        t.time_in_daylight_today as today,
        w.avg_time_in_daylight_7d as weekly_average
      FROM today_daylight t, weekly_avg w`
  },
  headphoneExposure: {
    latest: `
      WITH current_exposure AS (
        SELECT 
          COALESCE(ROUND(value::numeric, 0), 0) as current_exposure,
          timestamp as reading_time
        FROM health_aggregated
        WHERE metric_name = 'headphone_audio_exposure'
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      weekly_avg AS (
        SELECT
          COALESCE(ROUND(AVG(value)::numeric, 0), 0) AS avg_headphone_audio_exposure_7d
        FROM health_aggregated
        WHERE metric_name = 'headphone_audio_exposure'
          AND timestamp >= NOW() - INTERVAL '7 days'
      )
      SELECT 
        c.current_exposure as value,
        c.reading_time as timestamp,
        w.avg_headphone_audio_exposure_7d as weekly_average
      FROM current_exposure c, weekly_avg w`
  },
  getCurrentHealthStats: `
    WITH
    -- 1. Heart rate
    curr_hr AS (
      SELECT ROUND(value)::int AS current_heart_rate
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
      ORDER BY timestamp DESC
      LIMIT 1
    ),
    avg_hr AS (
      SELECT ROUND(AVG(value)::numeric,1) AS avg_heart_rate_today
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
        AND timestamp::date = CURRENT_DATE
    ),
    -- 2. Respiratory rate
    curr_resp AS (
      SELECT ROUND(value)::int AS current_respiratory_rate
      FROM health_realtime
      WHERE metric_name = 'respiratory_rate'
      ORDER BY timestamp DESC
      LIMIT 1
    ),
    avg_resp AS (
      SELECT ROUND(AVG(value)::numeric,1) AS avg_respiratory_rate_today
      FROM health_realtime
      WHERE metric_name = 'respiratory_rate'
        AND timestamp::date = CURRENT_DATE
    ),
    -- 3. Heart rate variability
    curr_hrv AS (
      SELECT value AS current_hr_variability
      FROM health_aggregated
      WHERE metric_name = 'heart_rate_variability'
      ORDER BY timestamp DESC
      LIMIT 1
    ),
    avg_hrv AS (
      SELECT ROUND(AVG(value)::numeric,2) AS avg_hr_variability_10d
      FROM health_aggregated
      WHERE metric_name = 'heart_rate_variability'
        AND timestamp >= CURRENT_DATE - INTERVAL '10 days'
    ),
    -- 4. Sleep temperature
    curr_temp AS (
      SELECT value AS current_sleeping_temperature
      FROM health_aggregated
      WHERE metric_name = 'apple_sleeping_wrist_temperature'
      ORDER BY timestamp DESC
      LIMIT 1
    ),
    avg_temp AS (
      SELECT ROUND(AVG(value)::numeric,2) AS avg_sleeping_temperature_7d
      FROM health_aggregated
      WHERE metric_name = 'apple_sleeping_wrist_temperature'
        AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
    ),
    -- 5. Audio exposure
    curr_audio AS (
      SELECT COALESCE(ROUND(value::numeric, 0), 0) AS current_audio_exposure
      FROM health_aggregated
      WHERE metric_name = 'headphone_audio_exposure'
      ORDER BY timestamp DESC
      LIMIT 1
    ),
    avg_audio AS (
      SELECT COALESCE(ROUND(AVG(value)::numeric, 0), 0) AS avg_audio_exposure_7d
      FROM health_aggregated
      WHERE metric_name = 'headphone_audio_exposure'
        AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
    ),
    -- 6. Latest sleep
    latest_sleep AS (
      SELECT
        COALESCE((deep + core + rem), 0) AS total_sleep_last,
        COALESCE(deep, 0) AS deep_sleep_last,
        COALESCE(rem, 0) AS rem_sleep_last
      FROM sleep_analysis
      WHERE record_date = CURRENT_DATE - INTERVAL '1 day'
      ORDER BY record_date DESC
      LIMIT 1
    ),
    -- 7. Steps today
    steps_today AS (
      SELECT COALESCE(SUM(value), 0) AS total_steps_today
      FROM health_realtime
      WHERE metric_name = 'step_count'
        AND timestamp::date = CURRENT_DATE
    ),
    -- 8. Exercise time today
    exercise_today AS (
      SELECT COALESCE(SUM(value), 0) AS exercise_time_today
      FROM health_aggregated
      WHERE metric_name = 'apple_exercise_time'
        AND timestamp::date = CURRENT_DATE
    ),
    -- 9. Daylight exposure today
    daylight_today AS (
      SELECT COALESCE(SUM(value), 0) AS time_in_daylight_today
      FROM health_aggregated
      WHERE metric_name = 'time_in_daylight'
        AND timestamp::date = CURRENT_DATE
    ),
    -- 10. Latest mood
    latest_mood AS (
      SELECT mood AS latest_mood
      FROM mental_health
      ORDER BY logged_at DESC
      LIMIT 1
    )
    SELECT json_build_object(
      'current_heart_rate',        curr_hr.current_heart_rate,
      'avg_heart_rate_today',      avg_hr.avg_heart_rate_today,
      'current_respiratory_rate',  curr_resp.current_respiratory_rate,
      'avg_respiratory_rate_today',avg_resp.avg_respiratory_rate_today,
      'current_hr_variability',    curr_hrv.current_hr_variability,
      'avg_hr_variability_10d',    avg_hrv.avg_hr_variability_10d,
      'current_sleeping_temperature', curr_temp.current_sleeping_temperature,
      'avg_sleeping_temperature_7d',  avg_temp.avg_sleeping_temperature_7d,
      'current_audio_exposure',    curr_audio.current_audio_exposure,
      'avg_audio_exposure_7d',     avg_audio.avg_audio_exposure_7d,
      'total_sleep_last',          latest_sleep.total_sleep_last,
      'deep_sleep_last',           latest_sleep.deep_sleep_last,
      'rem_sleep_last',            latest_sleep.rem_sleep_last,
      'total_steps_today',         steps_today.total_steps_today,
      'exercise_time_today',       exercise_today.exercise_time_today,
      'time_in_daylight_today',    daylight_today.time_in_daylight_today,
      'latest_mood',               latest_mood.latest_mood
    ) AS health_report
    FROM curr_hr
    JOIN avg_hr         ON true
    JOIN curr_resp      ON true
    JOIN avg_resp       ON true
    JOIN curr_hrv       ON true
    JOIN avg_hrv        ON true
    JOIN curr_temp      ON true
    JOIN avg_temp       ON true
    JOIN curr_audio     ON true
    JOIN avg_audio      ON true
    JOIN latest_sleep   ON true
    JOIN steps_today    ON true
    JOIN exercise_today ON true
    JOIN daylight_today ON true
    JOIN latest_mood    ON true;
  `
};

// Configure CORS and JSON parsing
app.use(cors());
app.use(express.json({limit: '50mb'}));

// Create PostgreSQL pool
const pool = new pg.Pool({
  user: 'shovan',
  host: 'localhost',
  database: 'health_data',
  password: '',
  port: 5432,
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Function to save blob to temporary file
async function saveBlobToTemp(blob, filename) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-reports-'));
  const filepath = path.join(tempDir, filename);
  await fs.writeFile(filepath, blob);
  return { filepath, tempDir };
}

// Function to clean up temporary files
async function cleanupTempFiles(tempDir) {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error('Error cleaning up temp files:', error);
  }
}

// Email reports endpoint
app.post('/api/reports/email', upload.array('reports'), async (req, res) => {
  let tempDir = null;
  
  try {
    if (!req.files || req.files.length === 0) {
      throw new Error('No reports provided');
    }

    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-reports-'));

    // Save uploaded files to temp directory
    const filePaths = await Promise.all(
      req.files.map(async (file) => {
        const filepath = path.join(tempDir, file.originalname);
        await fs.writeFile(filepath, file.buffer);
        return filepath;
      })
    );

    // Call Python script to send email
    const pythonArgs = [
      'sendEmail.py',
      '--files', ...filePaths,
      '--sender', 'Shovan.rautt@gmail.com',
      '--receiver', 'sraut@caldwell.edu',
      '--subject', 'Your Health Reports',
      '--body', 'Please find attached your health reports.\n\nBest regards.'
    ];

    const pythonProcess = spawn('python3', pythonArgs);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
      outputData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    await new Promise((resolve, reject) => {
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Python script failed with code ${code}: ${errorData}`));
        }
      });

      pythonProcess.on('error', (error) => {
        reject(new Error(`Failed to start Python process: ${error.message}`));
      });
    });

    res.json({ message: 'Reports sent successfully' });

  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (tempDir) {
      await cleanupTempFiles(tempDir);
    }
  }
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working' });
});

// Utility function to aggregate and insert data
const aggregateAndInsertData = async (client, metricName, date) => {
  const aggregateQuery = `
    INSERT INTO health_aggregated (metric_name, timestamp, value)
    SELECT 
      metric_name,
      DATE_TRUNC('day', timestamp) as agg_date,
      SUM(value) as total_value
    FROM health_realtime
    WHERE metric_name = $1
      AND DATE_TRUNC('day', timestamp) = DATE_TRUNC('day', $2::timestamp)
    GROUP BY metric_name, agg_date
    ON CONFLICT (metric_name, timestamp)
    DO UPDATE SET value = EXCLUDED.value;
  `;
  
  await client.query(aggregateQuery, [metricName, date]);
};

// Data import endpoint
app.post("/api/data", async (req, res) => {
  const client = await pool.connect();
  try {
    const metrics = req.body.data.metrics;
    const importTimestamp = new Date().toISOString();
    let totalEntries = metrics.reduce((sum, metric) => sum + (metric.data?.length || 0), 0);
    let processedEntries = 0;
    let failedEntries = 0;

    console.log(`Automated Import Received at ${importTimestamp}: ${metrics.length} metric(s) containing ${totalEntries} total entries.`);

    for (const metric of metrics) {
      const { name, units, data } = metric;
      console.log('Processing metric:', name);
      
      // Start a new transaction for each metric
      await client.query('BEGIN');
      
      try {
        for (const entry of data) {
          if (!entry.date) {
            console.log(`⚠️ Skipping entry - missing date for ${name}:`, entry);
            continue;
          }

          try {
            switch (name) {
              case 'heart_rate':
                await processHeartRate(client, entry);
                break;
              
              case 'sleep_analysis':
                await processSleepAnalysis(client, entry);
                break;
              
              default:
                await processStandardMetric(client, name, units, entry);
            }
            processedEntries++;
          } catch (entryError) {
            console.error(`❌ Error processing entry for metric ${name}:`, entryError);
            failedEntries++;
            // Don't throw here - continue processing other entries
          }
        }
        
        // Commit transaction for this metric if all entries processed
        await client.query('COMMIT');
      } catch (metricError) {
        // Rollback transaction for this metric if any error occurred
        await client.query('ROLLBACK');
        console.error(`❌ Error processing metric ${name}:`, metricError);
      }
    }

    // Notify all connected clients about the new data
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'REFRESH_DATA' }));
      }
    });

    res.json({ 
      success: true, 
      message: `Processed ${processedEntries} entries successfully, ${failedEntries} entries failed`,
      totalMetrics: metrics.length
    });
  } catch (err) {
    console.error("❌ Error processing automated import:", err);
    // Ensure transaction is rolled back in case of error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr);
    }
    res.status(500).json({ 
      error: 'Import failed', 
      details: err.message 
    });
  } finally {
    client.release();
  }
});

async function processHeartRate(client, entry) {
  const heartRateValue = entry.qty ?? entry.Avg;
  if (heartRateValue === undefined) {
    console.log("⚠️ Skipping heart_rate entry (missing qty/Average):", entry);
    return;
  }

  const query = `
    INSERT INTO health_realtime (metric_name, timestamp, value, source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (metric_name, timestamp, value) 
    DO UPDATE SET source = EXCLUDED.source`;
    
  await client.query(query, ['heart_rate', entry.date, heartRateValue, entry.source || null]);
}

async function processSleepAnalysis(client, entry) {
  console.log('🛌 Processing sleep_analysis data');
  
  const sleepData = {
    recordDate: entry.date ? new Date(entry.date) : null,
    sleepStart: entry.sleepStart ? new Date(entry.sleepStart) : null,
    sleepEnd: entry.sleepEnd ? new Date(entry.sleepEnd) : null,
    inBedStart: entry.inBedStart ? new Date(entry.inBedStart) : null,
    inBedEnd: entry.inBedEnd ? new Date(entry.inBedEnd) : null,
    inBed: entry.inBedStart && entry.inBedEnd ? 
      (new Date(entry.inBedEnd) - new Date(entry.inBedStart)) / (1000 * 60 * 60) : null,
    asleep: entry.asleep ?? null,
    deep: entry.deep ?? null,
    core: entry.core ?? null,
    rem: entry.rem ?? null,
    awake: entry.awake ?? null,
    source: entry.source || null,
    rawData: JSON.stringify(entry)
  };

  // First try to update
  const updateQuery = `
    UPDATE sleep_analysis 
    SET 
      sleep_start = $2,
      sleep_end = $3,
      in_bed_start = $4,
      in_bed_end = $5,
      in_bed = $6,
      asleep = $7,
      deep = $8,
      core = $9,
      rem = $10,
      awake = $11,
      source = $12,
      raw_data = $13
    WHERE record_date = $1
    RETURNING *`;

  let result = await client.query(updateQuery, Object.values(sleepData));
  
  // If no row was updated, insert a new one
  if (result.rowCount === 0) {
    const insertQuery = `
      INSERT INTO sleep_analysis 
        (record_date, sleep_start, sleep_end, in_bed_start, in_bed_end, in_bed,
         asleep, deep, core, rem, awake, source, raw_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

    await client.query(insertQuery, Object.values(sleepData));
  }
}

async function processStandardMetric(client, name, units, entry) {
  if (entry.qty === undefined || entry.qty === null) {
    console.log(`⚠️ Skipping ${name} entry - missing qty:`, entry);
    return;
  }

  const realtimeMetrics = ['step_count', 'active_energy', 'respiratory_rate'];
  const isRealtime = realtimeMetrics.includes(name);

  const query = isRealtime
    ? `INSERT INTO health_realtime (metric_name, timestamp, value, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (metric_name, timestamp, value) 
       DO UPDATE SET source = EXCLUDED.source`
    : `INSERT INTO health_aggregated (metric_name, timestamp, value, units, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (metric_name, timestamp)
       DO UPDATE SET value = EXCLUDED.value, units = EXCLUDED.units, source = EXCLUDED.source`;

  const values = isRealtime
    ? [name, entry.date, entry.qty, entry.source || null]
    : [name, entry.date, entry.qty, units || null, entry.source || null];

  await client.query(query, values);
}

// Test endpoint to verify server is running
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running' });
});

// Heart rate endpoints
app.get('/api/heart-rate/current', async (req, res) => {
  try {
    const query = `
      SELECT
        ROUND(value)::integer  AS latest_heart_rate,
        timestamp             AS reading_time
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
      ORDER BY timestamp DESC
      LIMIT 1;
    `;
    
    const result = await pool.query(query);
    console.log('Current heart rate query result:', result.rows[0]);
    res.json(result.rows[0] || { latest_heart_rate: null, reading_time: null });
  } catch (err) {
    console.error('Error fetching current heart rate:', err);
    res.status(500).json({ error: 'Failed to fetch heart rate data' });
  }
});

app.get('/api/heart-rate/daily-range', async (req, res) => {
  try {
    const query = `
      SELECT
        MIN(value)    AS min_heart_rate,
        MAX(value)    AS max_heart_rate
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
        AND timestamp::date = CURRENT_DATE;
    `;
    
    const result = await pool.query(query);
    console.log('Heart rate range query result:', result.rows[0]);
    res.json(result.rows[0] || { min_heart_rate: null, max_heart_rate: null });
  } catch (err) {
    console.error('Error fetching heart rate range:', err);
    res.status(500).json({ error: 'Failed to fetch heart rate range' });
  }
});

// Heart rate history endpoint
app.get('/api/heart-rate/today', async (req, res) => {
  try {
    const query = `
      SELECT
        timestamp,
        value AS heart_rate_bpm
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
        AND timestamp::date = CURRENT_DATE
      ORDER BY timestamp ASC;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching heart rate history:', err);
    res.status(500).json({ error: 'Failed to fetch heart rate history' });
  }
});

// Steps endpoint
app.get('/api/steps/today', async (req, res) => {
  try {
    const query = `
      SELECT 
        ROUND(SUM(value))::integer as steps
      FROM health_realtime
      WHERE metric_name = 'step_count'
        AND timestamp::date = CURRENT_DATE;
    `;
    
    const result = await pool.query(query);
    res.json({ steps: result.rows[0]?.steps || 0 });
  } catch (err) {
    console.error('Error fetching steps:', err);
    res.status(500).json({ error: 'Failed to fetch steps data' });
  }
});

// Weekly steps endpoint - show last 7 days
app.get('/api/steps/weekly', async (req, res) => {
  try {
    const query = `
      SELECT
        timestamp::date               AS day,
        ROUND(SUM(value))::integer   AS total_steps
      FROM health_realtime
      WHERE metric_name = 'step_count'
        AND timestamp::date BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
      GROUP BY day
      ORDER BY day;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching weekly steps:', err);
    res.status(500).json({ error: 'Failed to fetch weekly steps data' });
  }
});

// Respiratory rate endpoints
app.get('/api/respiratory-rate/current', async (req, res) => {
  try {
    const result = await pool.query(queries.respiratoryRate.current);
    res.json(result.rows[0] || { current_resp_rate: null, reading_time: null });
  } catch (err) {
    console.error('Error fetching current respiratory rate:', err);
    res.status(500).json({ 
      error: 'Failed to fetch respiratory rate data',
      details: err.message 
    });
  }
});

app.get('/api/respiratory-rate/daily-average', async (req, res) => {
  try {
    const result = await pool.query(queries.respiratoryRate.dailyAverage);
    console.log('Respiratory rate average result:', result.rows[0]); // Debug log
    res.json(result.rows[0] || { avg_resp_rate_today: null });
  } catch (err) {
    console.error('Error fetching average respiratory rate:', err);
    res.status(500).json({ 
      error: 'Failed to fetch average respiratory rate data',
      details: err.message 
    });
  }
});

// Time in daylight endpoint
app.get('/api/daylight/weekly', async (req, res) => {
  try {
    const result = await pool.query(queries.daylight.weekly);
    console.log('Daylight query result:', result.rows[0]); // Debug log
    res.json(result.rows[0] || { today: 0, weekly_average: 0 });
  } catch (err) {
    console.error('Error fetching daylight data:', err);
    res.status(500).json({ 
      error: 'Failed to fetch daylight data',
      details: err.message 
    });
  }
});

// Sleep average endpoint
app.get('/api/sleep/weekly-average', async (req, res) => {
  try {
    const query = `
      SELECT ROUND(AVG(total_sleep_hours)::numeric, 2) AS average
      FROM (
        SELECT
          record_date::date AS day,
          ROUND(SUM(deep + core + rem)::numeric, 2) AS total_sleep_hours
        FROM sleep_analysis
        WHERE record_date >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY day
      ) daily_sleep`;
    
    const result = await pool.query(query);
    res.json({ average: result.rows[0].average || null });
  } catch (err) {
    console.error('Error fetching sleep average:', err);
    res.status(500).json({ error: 'Failed to fetch sleep average' });
  }
});

app.get('/api/sleep/latest', async (req, res) => {
  try {
    const query = `
      SELECT
        record_date,
        ROUND(SUM(deep + core + rem)::numeric, 2) AS total_sleep_hours,
        ROUND(deep::numeric, 2) AS deep_sleep_hours,
        ROUND(core::numeric, 2) AS core_sleep_hours,
        ROUND(rem::numeric, 2) AS rem_sleep_hours
      FROM sleep_analysis
      WHERE record_date = (
        SELECT MAX(record_date)
        FROM sleep_analysis
      )
      GROUP BY record_date, deep, core, rem`;
    
    const result = await pool.query(query);
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Error fetching latest sleep data:', err);
    res.status(500).json({ error: 'Failed to fetch latest sleep data' });
  }
});

app.get('/api/sleep/weekly-timeline', async (req, res) => {
  try {
    const query = `
      WITH date_range AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '6 days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      )
      SELECT
        dr.date as record_date,
        COALESCE(
          ROUND(SUM(sa.deep + sa.core + sa.rem)::numeric, 2)
        , 0) AS total_sleep_hours,
        sa.sleep_start,
        sa.sleep_end,
        COALESCE(ROUND(sa.deep::numeric, 2), 0) AS deep_sleep_hours,
        COALESCE(ROUND(sa.core::numeric, 2), 0) AS core_sleep_hours,
        COALESCE(ROUND(sa.rem::numeric, 2), 0) AS rem_sleep_hours,
        COALESCE(ROUND(sa.awake::numeric, 2), 0) AS awake_hours
      FROM date_range dr
      LEFT JOIN sleep_analysis sa ON dr.date = sa.record_date::date
      GROUP BY 
        dr.date, 
        sa.sleep_start, 
        sa.sleep_end, 
        sa.deep, 
        sa.core, 
        sa.rem, 
        sa.awake
      ORDER BY dr.date ASC`;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching sleep timeline:', err);
    res.status(500).json({ error: 'Failed to fetch sleep timeline' });
  }
});

// Active Energy endpoint
app.get('/api/active-energy/weekly', async (req, res) => {
  try {
    const query = `
      SELECT
        hr.timestamp::date    AS day,
        SUM(value)            AS active_energy_kcal
      FROM health_realtime hr
      WHERE metric_name = 'active_energy'
        AND hr.timestamp::date >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY day
      ORDER BY day DESC;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching active energy data:', err);
    res.status(500).json({ error: 'Failed to fetch active energy data' });
  }
});

// Exercise and Resting Heart Rate endpoint
app.get('/api/exercise-heart-rate/weekly', async (req, res) => {
  try {
    const query = queries.exerciseAndHeartRate.weeklyStats;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching exercise and heart rate data:', err);
    res.status(500).json({ error: 'Failed to fetch exercise and heart rate data' });
  }
});

// Get current goals
app.get('/api/goals', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT sleep_goal_hours, active_burn_goal_kcal, step_goal_count FROM goals ORDER BY created_at DESC LIMIT 1'
    );
    res.json(result.rows[0] || {
      sleep_goal_hours: 8,
      active_burn_goal_kcal: 500,
      step_goal_count: 10000
    });
  } catch (err) {
    console.error('Error fetching goals:', err);
    res.status(500).json({ error: 'Failed to fetch goals' });
  } finally {
    client.release();
  }
});

// Update goals
app.post('/api/goals', async (req, res) => {
  const client = await pool.connect();
  try {
    const { sleep_goal_hours, active_burn_goal_kcal, step_goal_count } = req.body;
    
    await client.query(
      `INSERT INTO goals (sleep_goal_hours, active_burn_goal_kcal, step_goal_count)
       VALUES ($1, $2, $3)`,
      [sleep_goal_hours, active_burn_goal_kcal, step_goal_count]
    );
    
    res.json({ message: 'Goals updated successfully' });
  } catch (err) {
    console.error('Error updating goals:', err);
    res.status(500).json({ error: 'Failed to update goals' });
  } finally {
    client.release();
  }
});

// Get latest BMI data
app.get('/api/bmi/latest', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT weight_kg, height_cm, sex, age, bmi_value FROM bmi_index ORDER BY created_at DESC LIMIT 1'
    );
    res.json(result.rows[0] || {
      weight_kg: '',
      height_cm: '',
      sex: '',
      age: '',
      bmi_value: null
    });
  } catch (err) {
    console.error('Error fetching BMI data:', err);
    res.status(500).json({ error: 'Failed to fetch BMI data' });
  } finally {
    client.release();
  }
});

// Update BMI data
app.post('/api/bmi', async (req, res) => {
  const client = await pool.connect();
  try {
    const { weight_kg, height_cm, sex, age } = req.body;
    
    await client.query(
      `INSERT INTO bmi_index (weight_kg, height_cm, sex, age)
       VALUES ($1, $2, $3, $4)`,
      [weight_kg, height_cm, sex, age]
    );
    
    res.json({ message: 'BMI data updated successfully' });
  } catch (err) {
    console.error('Error updating BMI data:', err);
    res.status(500).json({ error: 'Failed to update BMI data' });
  } finally {
    client.release();
  }
});

// Headphone Audio Exposure endpoint
app.get('/api/headphone-exposure/latest', async (req, res) => {
  try {
    const query = queries.headphoneExposure.latest;
    const result = await pool.query(query);
    console.log('Headphone exposure data:', result.rows[0]); // Debug log
    
    res.json(result.rows[0] || { 
      value: 0, 
      timestamp: null, 
      weekly_average: 0 
    });
  } catch (err) {
    console.error('Error fetching headphone exposure data:', err);
    res.status(500).json({ 
      error: 'Failed to fetch headphone exposure data',
      details: err.message 
    });
  }
});

// Weekly trends endpoint
app.get('/api/trends/weekly', async (req, res) => {
  const client = await pool.connect();
  try {
    const weeklyQuery = `
      WITH 
      -- Sleep data by week using accurate calculation
      sleep_week AS (
        SELECT
          date_trunc('week', record_date::date)::date AS week_start,
          ROUND(SUM(deep + core + rem)::numeric, 2) AS total_sleep_hrs
        FROM sleep_analysis
        GROUP BY 1
      ),
      
      -- Metrics by week
      metrics_week AS (
        SELECT
          date_trunc('week', timestamp::date)::date AS week_start,
          SUM(CASE WHEN metric_name = 'active_energy' THEN value ELSE 0 END) AS total_active_kcal,
          SUM(CASE WHEN metric_name = 'step_count' THEN value ELSE 0 END) AS total_steps,
          AVG(CASE WHEN metric_name = 'heart_rate' THEN value ELSE NULL END) AS avg_heart_rate
        FROM health_realtime
        GROUP BY 1
      ),
      
      -- Join current and previous week data
      week_pair AS (
        SELECT
          s1.total_sleep_hrs AS sleep_previous,
          s2.total_sleep_hrs AS sleep_current,
          m1.total_active_kcal AS energy_previous,
          m2.total_active_kcal AS energy_current,
          ROUND(m1.avg_heart_rate::numeric, 1) AS heart_rate_previous,
          ROUND(m2.avg_heart_rate::numeric, 1) AS heart_rate_current,
          m1.total_steps AS steps_previous,
          m2.total_steps AS steps_current
        FROM sleep_week s1
          JOIN sleep_week s2 ON s2.week_start = s1.week_start + INTERVAL '1 week'
          JOIN metrics_week m1 ON m1.week_start = s1.week_start
          JOIN metrics_week m2 ON m2.week_start = s2.week_start
        WHERE s1.week_start = date_trunc('week', CURRENT_DATE - INTERVAL '2 week')
      )
      SELECT json_build_object(
        'sleep_current', ROUND(sleep_current::numeric, 2),
        'sleep_previous', ROUND(sleep_previous::numeric, 2),
        'sleep_pct_change', ROUND(((sleep_current - sleep_previous) / NULLIF(sleep_previous, 0) * 100)::numeric, 2),
        
        'heart_rate_current', ROUND(heart_rate_current::numeric, 1),
        'heart_rate_previous', ROUND(heart_rate_previous::numeric, 1),
        'heart_rate_pct_change', ROUND(((heart_rate_current - heart_rate_previous) / NULLIF(heart_rate_previous, 0) * 100)::numeric, 2),
        
        'steps_current', ROUND(steps_current::numeric, 0),
        'steps_previous', ROUND(steps_previous::numeric, 0),
        'steps_pct_change', ROUND(((steps_current - steps_previous) / NULLIF(steps_previous, 0) * 100)::numeric, 2),
        
        'energy_current', ROUND(energy_current::numeric, 0),
        'energy_previous', ROUND(energy_previous::numeric, 0),
        'energy_pct_change', ROUND(((energy_current - energy_previous) / NULLIF(energy_previous, 0) * 100)::numeric, 2)
      ) as trends
      FROM week_pair;
    `;

    const result = await client.query(weeklyQuery);
    res.json(result.rows[0].trends);
  } catch (err) {
    console.error('Error fetching weekly trends:', err);
    res.status(500).json({ error: 'Failed to fetch weekly trends' });
  } finally {
    client.release();
  }
});

// Daily trends endpoint
app.get('/api/trends/daily', async (req, res) => {
  const client = await pool.connect();
  try {
    const dailyQuery = `
      WITH 
      -- Daily sleep metrics using latest sleep record
      sleep_metrics AS (
        SELECT
          COALESCE(
            (SELECT ROUND(SUM(deep + core + rem)::numeric, 2)
             FROM sleep_analysis
             WHERE record_date = (
               SELECT MAX(record_date)
               FROM sleep_analysis
             )),
            0
          ) as current_sleep,
          COALESCE(
            (SELECT ROUND(SUM(deep + core + rem)::numeric, 2)
             FROM sleep_analysis
             WHERE record_date = (
               SELECT MAX(record_date) - 1
               FROM sleep_analysis
             )),
            0
          ) as previous_sleep
      ),
      
      -- Daily health metrics
      daily_metrics AS (
        SELECT 
          metric_name,
          -- For heart rate, use AVG instead of SUM
          CASE 
            WHEN metric_name = 'heart_rate' THEN
              AVG(CASE WHEN timestamp::date = CURRENT_DATE THEN value ELSE NULL END)
            ELSE
              SUM(CASE WHEN timestamp::date = CURRENT_DATE THEN value ELSE 0 END)
          END as current_value,
          
          CASE 
            WHEN metric_name = 'heart_rate' THEN
              AVG(CASE WHEN timestamp::date = CURRENT_DATE - INTERVAL '1 day' THEN value ELSE NULL END)
            ELSE
              SUM(CASE WHEN timestamp::date = CURRENT_DATE - INTERVAL '1 day' THEN value ELSE 0 END)
          END as previous_value
        FROM health_realtime
        WHERE timestamp >= CURRENT_DATE - INTERVAL '1 day'
          AND metric_name IN ('heart_rate', 'step_count', 'active_energy')
        GROUP BY metric_name
      )
      
      SELECT json_build_object(
        'sleep_current', ROUND(s.current_sleep::numeric, 2),
        'sleep_previous', ROUND(s.previous_sleep::numeric, 2),
        'sleep_pct_change', CASE 
          WHEN s.previous_sleep = 0 THEN 0
          ELSE ROUND(((s.current_sleep - s.previous_sleep) / NULLIF(s.previous_sleep, 0) * 100)::numeric, 2)
        END,
        
        'heart_rate_current', ROUND((SELECT current_value FROM daily_metrics WHERE metric_name = 'heart_rate')::numeric, 1),
        'heart_rate_previous', ROUND((SELECT previous_value FROM daily_metrics WHERE metric_name = 'heart_rate')::numeric, 1),
        'heart_rate_pct_change', ROUND(((
          (SELECT current_value FROM daily_metrics WHERE metric_name = 'heart_rate') -
          (SELECT previous_value FROM daily_metrics WHERE metric_name = 'heart_rate')
        ) / NULLIF((SELECT previous_value FROM daily_metrics WHERE metric_name = 'heart_rate'), 0) * 100)::numeric, 2),
        
        'steps_current', ROUND((SELECT current_value FROM daily_metrics WHERE metric_name = 'step_count')::numeric, 0),
        'steps_previous', ROUND((SELECT previous_value FROM daily_metrics WHERE metric_name = 'step_count')::numeric, 0),
        'steps_pct_change', ROUND(((
          (SELECT current_value FROM daily_metrics WHERE metric_name = 'step_count') -
          (SELECT previous_value FROM daily_metrics WHERE metric_name = 'step_count')
        ) / NULLIF((SELECT previous_value FROM daily_metrics WHERE metric_name = 'step_count'), 0) * 100)::numeric, 2),
        
        'energy_current', ROUND((SELECT current_value FROM daily_metrics WHERE metric_name = 'active_energy')::numeric, 0),
        'energy_previous', ROUND((SELECT previous_value FROM daily_metrics WHERE metric_name = 'active_energy')::numeric, 0),
        'energy_pct_change', ROUND(((
          (SELECT current_value FROM daily_metrics WHERE metric_name = 'active_energy') -
          (SELECT previous_value FROM daily_metrics WHERE metric_name = 'active_energy')
        ) / NULLIF((SELECT previous_value FROM daily_metrics WHERE metric_name = 'active_energy'), 0) * 100)::numeric, 2)
      ) as trends
      FROM sleep_metrics s;
    `;

    const result = await client.query(dailyQuery);
    res.json(result.rows[0].trends);
  } catch (err) {
    console.error('Error fetching daily trends:', err);
    res.status(500).json({ error: 'Failed to fetch daily trends' });
  } finally {
    client.release();
  }
});

// Health stats endpoint
app.get('/api/health/stats', async (req, res) => {
  const client = await pool.connect();
  try {
    const statsQuery = `
      WITH heart_rate_stats AS (
        SELECT 
          ROUND(AVG(value)::numeric, 0) as recent_resting_hr,
          (
            SELECT ROUND(AVG(value)::numeric, 0)
            FROM health_aggregated 
            WHERE metric_name = 'resting_heart_rate'
              AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
          ) as avg_resting_hr
        FROM health_aggregated 
        WHERE metric_name = 'resting_heart_rate'
          AND timestamp >= CURRENT_DATE - INTERVAL '24 hours'
      ),
      hrv_stats AS (
        SELECT 
          (SELECT value 
           FROM health_aggregated
           WHERE metric_name = 'heart_rate_variability'
           ORDER BY timestamp DESC
           LIMIT 1) as recent_hr_variability,
          (
            SELECT ROUND(AVG(value)::numeric, 2)
            FROM health_aggregated
            WHERE metric_name = 'heart_rate_variability'
              AND timestamp >= CURRENT_DATE - INTERVAL '10 days'
          ) as avg_hr_variability_10d
      ),
      sleep_temp_stats AS (
        SELECT 
          (SELECT value 
           FROM health_aggregated
           WHERE metric_name = 'apple_sleeping_wrist_temperature'
           ORDER BY timestamp DESC
           LIMIT 1) as recent_sleeping_temperature,
          (
            SELECT ROUND(AVG(value)::numeric, 2)
            FROM health_aggregated
            WHERE metric_name = 'apple_sleeping_wrist_temperature'
              AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
          ) as avg_sleeping_temperature
      ),
      audio_exposure_stats AS (
        SELECT 
          (SELECT COALESCE(ROUND(value::numeric, 0), 0) as recent_audio_exposure
           FROM health_aggregated
           WHERE metric_name = 'headphone_audio_exposure'
           ORDER BY timestamp DESC
           LIMIT 1) as recent_audio_exposure,
          (
            SELECT COALESCE(ROUND(AVG(value)::numeric, 0), 0) as avg_audio_exposure
            FROM health_aggregated
            WHERE metric_name = 'headphone_audio_exposure'
              AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
          ) as avg_audio_exposure
      )
      SELECT json_build_object(
        'recent_resting_hr', hr.recent_resting_hr,
        'avg_resting_hr', hr.avg_resting_hr,
        'recent_hr_variability', hrv.recent_hr_variability,
        'avg_hr_variability_10d', hrv.avg_hr_variability_10d,
        'recent_sleeping_temperature', st.recent_sleeping_temperature,
        'avg_sleeping_temperature', st.avg_sleeping_temperature,
        'recent_audio_exposure', COALESCE(ae.recent_audio_exposure, 0),
        'avg_audio_exposure', COALESCE(ae.avg_audio_exposure, 0)
      ) as stats
      FROM heart_rate_stats hr, 
           hrv_stats hrv, 
           sleep_temp_stats st,
           audio_exposure_stats ae;
    `;

    const result = await client.query(statsQuery);
    res.json(result.rows[0].stats);
  } catch (err) {
    console.error('Error fetching health stats:', err);
    res.status(500).json({ error: 'Failed to fetch health stats' });
  } finally {
    client.release();
  }
});

// Mental health logging endpoint
app.post('/api/mental-health/log', async (req, res) => {
  const client = await pool.connect();
  try {
    const { mood } = req.body;
    
    if (!mood) {
      return res.status(400).json({ error: 'Mood is required' });
    }

    const metricsQuery = `
      WITH current_metrics AS (
        SELECT value as heart_rate
        FROM health_realtime
        WHERE metric_name = 'heart_rate'
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      daily_energy AS (
        SELECT COALESCE(SUM(value), 0) as energy_burnt
        FROM health_realtime
        WHERE metric_name = 'active_energy'
        AND timestamp::date = CURRENT_DATE
      ),
      daily_daylight AS (
        SELECT COALESCE(SUM(value), 0) as daylight_minutes
        FROM health_aggregated
        WHERE metric_name = 'time_in_daylight'
        AND timestamp::date = CURRENT_DATE
      ),
      latest_sleep AS (
        SELECT 
          COALESCE((deep + core + rem), 0) as total_sleep_hours
        FROM sleep_analysis
        WHERE record_date = CURRENT_DATE - INTERVAL '1 day'
        ORDER BY record_date DESC
        LIMIT 1
      )
      SELECT 
        COALESCE((SELECT heart_rate FROM current_metrics), 0) as recent_heart_rate,
        COALESCE((SELECT energy_burnt FROM daily_energy), 0) as energy_burnt,
        COALESCE((SELECT total_sleep_hours FROM latest_sleep), 0) as total_sleep,
        COALESCE((SELECT daylight_minutes FROM daily_daylight), 0) as time_in_daylight`;

    const metricsResult = await client.query(metricsQuery);
    const metrics = metricsResult.rows[0];

    console.log('Metrics before insert:', metrics);

    const insertQuery = `
      INSERT INTO mental_health (
        mood, 
        recent_heart_rate, 
        energy_burnt, 
        total_sleep,
        time_in_daylight
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`;
    
    const result = await client.query(insertQuery, [
      mood,
      Math.round(metrics.recent_heart_rate || 0),
      Math.round(metrics.energy_burnt || 0),
      Number(metrics.total_sleep || 0),
      Math.round(metrics.time_in_daylight || 0)
    ]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Database Error:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      detail: err.detail
    });
    res.status(500).json({ 
      error: 'Failed to log mental health data',
      details: err.message 
    });
  } finally {
    client.release();
  }
});

// New endpoint for stress level calculation
app.get('/api/stress-level', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      WITH latest_metrics AS (
        SELECT 
          (SELECT value::numeric 
           FROM health_realtime 
           WHERE metric_name = 'heart_rate' 
           ORDER BY timestamp DESC 
           LIMIT 1) as heart_rate,
          
          (SELECT (deep + core + rem)
           FROM sleep_analysis 
           WHERE record_date = CURRENT_DATE - INTERVAL '1 day'
           ORDER BY record_date DESC
           LIMIT 1) as sleep_hours,
          
          (SELECT COUNT(*) 
           FROM mental_health 
           WHERE mood = '😢' 
           AND logged_at > NOW() - INTERVAL '24 hours') as negative_moods
      )
      SELECT 
        COALESCE(heart_rate, 0) as heart_rate,
        COALESCE(sleep_hours, 0) as sleep_hours,
        COALESCE(negative_moods, 0) as negative_moods,
        CASE
          WHEN COALESCE(heart_rate, 0) > 90 OR COALESCE(sleep_hours, 0) < 6 OR COALESCE(negative_moods, 0) > 2 THEN 'high'
          WHEN COALESCE(heart_rate, 0) > 75 OR COALESCE(sleep_hours, 0) < 7 OR COALESCE(negative_moods, 0) > 0 THEN 'moderate'
          ELSE 'low'
        END as stress_level,
        CASE
          WHEN COALESCE(heart_rate, 0) > 90 OR COALESCE(sleep_hours, 0) < 6 OR COALESCE(negative_moods, 0) > 2 THEN 80
          WHEN COALESCE(heart_rate, 0) > 75 OR COALESCE(sleep_hours, 0) < 7 OR COALESCE(negative_moods, 0) > 0 THEN 50
          ELSE 20
        END as stress_score
      FROM latest_metrics`;

    const result = await client.query(query);
    
    res.json({
      score: result.rows[0].stress_score,
      maxScore: 100,
      level: result.rows[0].stress_level,
      metrics: {
        heartRate: result.rows[0].heart_rate,
        sleepHours: result.rows[0].sleep_hours,
        negativeMoods: result.rows[0].negative_moods
      }
    });
  } catch (err) {
    console.error('Error calculating stress level:', err);
    res.status(500).json({ 
      error: 'Failed to calculate stress level',
      details: err.message 
    });
  } finally {
    client.release();
  }
});

// Get current health metrics endpoint
app.get('/api/health/current-metrics', async (req, res) => {
  const client = await pool.connect();
  try {
    // Get current heart rate
    const heartRateQuery = `
      SELECT value as heart_rate
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
      ORDER BY timestamp DESC
      LIMIT 1`;
    
    // Get today's total energy burnt
    const energyQuery = `
      SELECT COALESCE(SUM(value), 0) as energy_burnt
      FROM health_realtime
      WHERE metric_name = 'active_energy'
        AND timestamp::date = CURRENT_DATE`;
    
    // Get latest sleep duration
    const sleepQuery = `
      SELECT asleep as total_sleep
      FROM sleep_analysis
      WHERE record_date = CURRENT_DATE - INTERVAL '1 day'
      LIMIT 1`;
    
    // Get today's time in daylight
    const daylightQuery = `
      SELECT COALESCE(SUM(value), 0) as time_in_daylight
      FROM health_aggregated
      WHERE metric_name = 'time_in_daylight'
        AND timestamp::date = CURRENT_DATE`;
    
    const [heartRate, energy, sleep, daylight] = await Promise.all([
      client.query(heartRateQuery),
      client.query(energyQuery),
      client.query(sleepQuery),
      client.query(daylightQuery)
    ]);
    
    res.json({
      heart_rate: heartRate.rows[0]?.heart_rate,
      energy_burnt: energy.rows[0]?.energy_burnt,
      total_sleep: sleep.rows[0]?.total_sleep,
      time_in_daylight: daylight.rows[0]?.time_in_daylight
    });
  } catch (err) {
    console.error('Error fetching current metrics:', err);
    res.status(500).json({ error: 'Failed to fetch current metrics' });
  } finally {
    client.release();
  }
});

// Get recent mental health logs
app.get('/api/mental-health/recent', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT 
        m.id,
        m.mood,
        m.recent_heart_rate,
        m.energy_burnt,
        m.total_sleep,
        m.logged_at
      FROM mental_health m
      ORDER BY m.logged_at DESC
      LIMIT 10
    `;
    
    const result = await client.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent mental health logs:', err);
    res.status(500).json({ error: 'Failed to fetch mental health history' });
  } finally {
    client.release();
  }
});

// Generate Sleep Analysis Report
app.get('/api/reports/sleep', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      WITH daily_metrics AS (
        SELECT
          record_date,
          ROUND(EXTRACT(EPOCH FROM (sleep_end - sleep_start)) / 3600.0::numeric, 2) as total_hours,
          ROUND(deep::numeric, 2) as deep_sleep,
          ROUND(core::numeric, 2) as core_sleep,
          ROUND(rem::numeric, 2) as rem_sleep,
          ROUND(awake::numeric, 2) as time_awake,
          ROUND((deep + core + rem)::numeric, 2) as total_sleep_time
        FROM sleep_analysis
        WHERE record_date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY record_date DESC
      ),
      sleep_stats AS (
        SELECT
          ROUND(AVG(total_hours)::numeric, 2) as avg_total_hours,
          ROUND(AVG(deep_sleep)::numeric, 2) as avg_deep_sleep,
          ROUND(AVG(rem_sleep)::numeric, 2) as avg_rem_sleep,
          ROUND(AVG(core_sleep)::numeric, 2) as avg_core_sleep,
          ROUND(AVG(time_awake)::numeric, 2) as avg_time_awake,
          ROUND(AVG(total_sleep_time)::numeric, 2) as avg_total_sleep
        FROM daily_metrics
      )
      SELECT 
        json_build_object(
          'daily_data', (SELECT json_agg(daily_metrics.*) FROM daily_metrics),
          'statistics', (SELECT row_to_json(sleep_stats.*) FROM sleep_stats)
        ) as report_data
    `;

    const result = await client.query(query);
    res.json(result.rows[0].report_data);
  } catch (err) {
    console.error('Error generating sleep report:', err);
    res.status(500).json({ error: 'Failed to generate sleep report' });
  } finally {
    client.release();
  }
});

// Generate Mood Patterns Report
app.get('/api/reports/mood', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      WITH mood_data AS (
        SELECT
          DATE_TRUNC('day', timestamp) as date,
          mood,
          recent_heart_rate,
          energy_burnt,
          total_sleep,
          notes
        FROM mental_health
        WHERE timestamp >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY date DESC
      ),
      mood_stats AS (
        SELECT
          COUNT(*) as total_entries,
          ROUND(AVG(recent_heart_rate)::numeric, 0) as avg_heart_rate,
          ROUND(AVG(energy_burnt)::numeric, 0) as avg_energy_burnt,
          ROUND(AVG(total_sleep)::numeric, 1) as avg_sleep,
          MODE() WITHIN GROUP (ORDER BY mood) as most_common_mood
        FROM mood_data
      ),
      mood_distribution AS (
        SELECT
          mood,
          COUNT(*) as count,
          ROUND((COUNT(*)::float / (SELECT COUNT(*) FROM mood_data) * 100)::numeric, 1) as percentage
        FROM mood_data
        GROUP BY mood
      )
      SELECT json_build_object(
        'daily_data', (SELECT json_agg(mood_data.*) FROM mood_data),
        'statistics', (SELECT row_to_json(mood_stats.*) FROM mood_stats),
        'distribution', (SELECT json_agg(mood_distribution.*) FROM mood_distribution)
      ) as report_data
    `;

    const result = await client.query(query);
    res.json(result.rows[0].report_data);
  } catch (err) {
    console.error('Error generating mood report:', err);
    res.status(500).json({ error: 'Failed to generate mood report' });
  } finally {
    client.release();
  }
});

// Generate Activity Impact Report
app.get('/api/reports/activity', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      WITH daily_activity AS (
        SELECT
          DATE_TRUNC('day', timestamp)::date as date,
          SUM(CASE WHEN metric_name = 'step_count' THEN value ELSE 0 END) as total_steps,
          SUM(CASE WHEN metric_name = 'active_energy' THEN value ELSE 0 END) as active_energy,
          ROUND(AVG(CASE WHEN metric_name = 'heart_rate' THEN value ELSE null END)::numeric, 0) as avg_heart_rate
        FROM health_realtime
        WHERE timestamp >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE_TRUNC('day', timestamp)::date
        ORDER BY date DESC
      ),
      activity_stats AS (
        SELECT
          ROUND(AVG(total_steps)::numeric, 0) as avg_daily_steps,
          ROUND(AVG(active_energy)::numeric, 0) as avg_active_energy,
          ROUND(AVG(avg_heart_rate)::numeric, 0) as avg_heart_rate,
          MAX(total_steps) as max_steps,
          MAX(active_energy) as max_energy
        FROM daily_activity
      ),
      mood_correlation AS (
        SELECT
          da.date,
          da.total_steps,
          da.active_energy,
          mh.mood
        FROM daily_activity da
        LEFT JOIN mental_health mh ON DATE_TRUNC('day', mh.timestamp)::date = da.date
      )
      SELECT json_build_object(
        'daily_data', (SELECT json_agg(daily_activity.*) FROM daily_activity),
        'statistics', (SELECT row_to_json(activity_stats.*) FROM activity_stats),
        'mood_correlation', (SELECT json_agg(mood_correlation.*) FROM mood_correlation)
      ) as report_data
    `;

    const result = await client.query(query);
    res.json(result.rows[0].report_data);
  } catch (err) {
    console.error('Error generating activity report:', err);
    res.status(500).json({ error: 'Failed to generate activity report' });
  } finally {
    client.release();
  }
});

// Save Generated Report
app.post('/api/reports', async (req, res) => {
  const client = await pool.connect();
  try {
    const { type, data } = req.body;
    
    const query = `
      INSERT INTO generated_reports (
        report_type,
        report_data,
        generated_at
      ) VALUES ($1, $2, CURRENT_TIMESTAMP)
      RETURNING id, report_type, generated_at
    `;
    
    const result = await client.query(query, [type, data]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving report:', err);
    res.status(500).json({ error: 'Failed to save report' });
  } finally {
    client.release();
  }
});

// Get Recent Reports
app.get('/api/reports/recent', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT 
        id,
        report_type,
        generated_at
      FROM generated_reports
      ORDER BY generated_at DESC
      LIMIT 5
    `;
    
    const result = await client.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent reports:', err);
    res.status(500).json({ error: 'Failed to fetch recent reports' });
  } finally {
    client.release();
  }
});

// Sleep Report CSV
app.get('/api/reports/sleep/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        record_date AS "Date",
        ROUND((deep + core + rem)::numeric, 2) AS "Total Sleep (hours)",
        ROUND(deep::numeric, 2) AS "Deep Sleep (hours)",
        ROUND(core::numeric, 2) AS "Core Sleep (hours)",
        ROUND(rem::numeric, 2) AS "REM Sleep (hours)",
        ROUND(awake::numeric, 2) AS "Time Awake (hours)"
      FROM sleep_analysis
      WHERE record_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY record_date DESC;
    `;

    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No sleep data found' });
      return;
    }

    const fields = ['Date', 'Total Sleep (hours)', 'Deep Sleep (hours)', 'Core Sleep (hours)', 'REM Sleep (hours)', 'Time Awake (hours)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=sleep_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating sleep report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Mood Report CSV
app.get('/api/reports/mood/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        logged_at as "Date",
        mood as "Mood",
        recent_heart_rate as "Heart Rate (bpm)",
        energy_burnt as "Energy Burnt (kcal)",
        total_sleep as "Sleep Duration (hours)",
        time_in_daylight as "Daylight Exposure (minutes)"
      FROM mental_health
      WHERE logged_at >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY logged_at DESC;
    `;

    const result = await client.query(query);
    
    const fields = ['Date', 'Mood', 'Heart Rate (bpm)', 'Energy Burnt (kcal)', 'Sleep Duration (hours)', 'Daylight Exposure (minutes)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=mood_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating mood report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Activity Report CSV
app.get('/api/reports/activity/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        DATE_TRUNC('day', timestamp)::date AS "Date",
        ROUND(SUM(CASE WHEN metric_name = 'active_energy' THEN value ELSE 0 END)::numeric, 0) AS "Active Energy (kcal)",
        ROUND(SUM(CASE WHEN metric_name = 'step_count' THEN value ELSE 0 END)::numeric, 0) AS "Steps",
        ROUND(AVG(CASE WHEN metric_name = 'heart_rate' THEN value ELSE NULL END)::numeric, 1) AS "Average Heart Rate (bpm)"
      FROM health_realtime
      WHERE timestamp >= CURRENT_DATE - INTERVAL '30 days'
        AND metric_name IN ('active_energy', 'step_count', 'heart_rate')
      GROUP BY DATE_TRUNC('day', timestamp)::date
      ORDER BY "Date" DESC;
    `;

    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No activity data found' });
      return;
    }

    const fields = ['Date', 'Active Energy (kcal)', 'Steps', 'Average Heart Rate (bpm)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=activity_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating activity report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Heart Rate Report CSV
app.get('/api/reports/heart-rate/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        DATE_TRUNC('day', timestamp)::date AS "Date",
        ROUND(AVG(value)::numeric, 1) AS "Average Heart Rate (bpm)",
        ROUND(MIN(value)::numeric, 1) AS "Minimum Heart Rate (bpm)",
        ROUND(MAX(value)::numeric, 1) AS "Maximum Heart Rate (bpm)"
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
        AND timestamp >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE_TRUNC('day', timestamp)::date
      ORDER BY "Date" DESC;
    `;

    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No heart rate data found' });
      return;
    }

    const fields = ['Date', 'Average Heart Rate (bpm)', 'Minimum Heart Rate (bpm)', 'Maximum Heart Rate (bpm)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=heart_rate_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating heart rate report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Exercise Report CSV
app.get('/api/reports/exercise/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        day as "Date",
        total_exercise as "Total Exercise (minutes)"
      FROM (
        SELECT
          hr.timestamp::date                     AS day,
          ROUND(SUM(hr.value)::numeric, 1)         AS total_exercise
        FROM health_aggregated  AS hr
        WHERE hr.metric_name = 'apple_exercise_time'
          AND hr.timestamp >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY hr.timestamp::date
      ) AS sub
      ORDER BY day;
    `;

    const result = await client.query(query);
    
    const fields = ['Date', 'Total Exercise (minutes)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=exercise_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating exercise report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Headphone Exposure Report CSV
app.get('/api/reports/headphone-exposure/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        day as "Date",
        COALESCE(ROUND(avg_headphone_exposure::numeric, 1), 0) as "Average Audio Exposure (dB)"
      FROM (
        SELECT
          timestamp::date AS day,
          AVG(value) as avg_headphone_exposure
        FROM health_aggregated
        WHERE metric_name = 'audio_exposure'
          AND timestamp >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY timestamp::date
      ) AS sub
      ORDER BY day DESC;
    `;

    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      // Return at least one row with zero values if no data
      result.rows = [{
        "Date": new Date().toISOString().split('T')[0],
        "Average Audio Exposure (dB)": 0
      }];
    }
    
    const fields = ['Date', 'Average Audio Exposure (dB)'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(result.rows);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=headphone_exposure_report.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error generating headphone exposure report:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  } finally {
    client.release();
  }
});

// Add this new endpoint to inspect the mental_health table
app.get('/api/debug/mental-health', async (req, res) => {
  const client = await pool.connect();
  try {
    // Get table structure
    const structureQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'mental_health';
    `;
    
    // Get all records
    const dataQuery = `
      SELECT * 
      FROM mental_health 
      ORDER BY logged_at DESC 
      LIMIT 10;
    `;
    
    const structure = await client.query(structureQuery);
    const data = await client.query(dataQuery);
    
    res.json({
      structure: structure.rows,
      data: data.rows
    });
  } catch (err) {
    console.error('Error fetching mental health data:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Add the chat endpoint
app.post('/api/chat', async (req, res) => {
  const client = await pool.connect();
  try {
    const { messages, message, mode = "chat" } = req.body; // Add mode parameter with default "chat"
    
    // Fetch current health stats
    const healthStats = await client.query(queries.getCurrentHealthStats);
    const healthData = healthStats.rows[0].health_report;
    
    const systemPrompt = `You are Shovan's personal AI health companion (22 years old, male, 60 kg)—part data analyst, part best friend—always warm, empathetic, and insightful.


General formatting rules (both modes):
  • **Emphasize key insights** by bolding them (e.g. **heart rate spike**, **sleep drop**).  
  • Break replies into short, clear paragraphs with line-breaks.  
  • Highlight specific values or percentages in \`inline code\`.  
  • Keep the tone casual—no "Hey Shovan" every time, just friendly chat.  
  • Pull fresh stats each time; don't recycle the same numbers.
  
Additional per-mode rules:


When Shovan writes something like "hmm sounds good, will let you know," or any non-health prompt in notification mode,  reply:just
> "Sure, I'm here whenever you need me."

When he indicates he's not feeling well or wants to chat ("I'm feeling low today"), automatically switch to **mode: "chat"** and give the full analysis.`;

    // Simplified context with only relevant metrics
    const latestContext = `
Mode: ${mode}

Health Stats:
HR: ${healthData.current_heart_rate}/${healthData.avg_heart_rate_today}bpm
RespRate: ${healthData.current_respiratory_rate}/${healthData.avg_respiratory_rate_today}
Sleep: ${healthData.total_sleep_last}h (Deep:${healthData.deep_sleep_last}h)
Exercise: ${healthData.exercise_time_today}min
Mood: ${healthData.latest_mood}`;

    // Keep only last 5 messages to reduce context
    const recentMessages = messages ? messages.slice(-5) : [];

    const conversationMessages = [
      { role: "system", content: systemPrompt },
      ...recentMessages,
      { 
        role: "user", 
        content: `${latestContext}\n\n${message}`
      }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: conversationMessages,
      temperature: 0.7,
      max_tokens: 500  // Reduced from 1000
    });

    const aiResponse = completion.choices[0].message.content;
    
    res.json({ 
      response: aiResponse,
      healthStats: healthData
    });
  } catch (err) {
    console.error('Error in chat endpoint:', err);
    res.status(500).json({ 
      error: 'Failed to process chat request', 
      details: err.message
    });
  } finally {
    client.release();
  }
});


// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Add this endpoint to your existing server.js
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
          WHERE ha.timestamp >= NOW() - INTERVAL '1 hour'
        ),
        'health_realtime', (
          SELECT COALESCE(json_agg(row_to_json(hr)), '[]')
          FROM health_realtime hr
          WHERE hr.timestamp >= NOW() - INTERVAL '1 hour'
        ),
        'mental_health', (
          SELECT COALESCE(json_agg(row_to_json(mh)), '[]')
          FROM mental_health mh
          WHERE mh.logged_at >= NOW() - INTERVAL '1 hour'
        )
      ) AS all_data`;

    const result = await client.query(query);
    const data = result.rows[0].all_data;

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

// Add notifications endpoint
app.post('/api/notifications', async (req, res) => {
  const client = await pool.connect();
  try {
    const { content } = req.body;
    
    const query = `
      INSERT INTO notifications (content)
      VALUES ($1)
      RETURNING id, content, received_at
    `;
    
    const result = await client.query(query, [content]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving notification:', err);
    res.status(500).json({ error: 'Failed to save notification' });
  } finally {
    client.release();
  }
});

// Add endpoint to fetch notifications
app.get('/api/notifications', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, content, received_at
      FROM notifications
      ORDER BY received_at DESC
      LIMIT 50
    `;
    
    const result = await client.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  } finally {
    client.release();
  }
});

// Add notifications analysis endpoint
app.post('/api/analyze-health', async (req, res) => {
  const client = await pool.connect();
  try {
    // Fetch current health stats
    const healthStats = await client.query(queries.getCurrentHealthStats);
    const healthData = healthStats.rows[0].health_report;
    
    const systemPrompt = `You are PulseX AI AI health analyzer focused on detecting concerning patterns or anomalies in health data from the last hour.

  General formatting rules ():
  • **Emphasize key insights** by bolding them (e.g. **heart rate spike**, **sleep drop**).  
  • Break replies into short, clear paragraphs with line-breaks.  
  • Highlight specific values or percentages in \`inline code\`.  
  • Keep the tone casual—no "Hey Shovan" every time, just friendly chat.  
  • Pull fresh stats each time; don't recycle the same numbers.

Your role is to:
• Generate short, punchy alerts (1-2 sentences max)
• Only highlight significant anomalies or concerning patterns
• Be direct and clear - no small talk or lengthy explanations
• If nothing is concerning, respond with exactly: "No immediate concerns."

Example outputs:
“Elevated heart rate detected—82 bpm is 15% above your baseline.”

“Sleep quality drop—only 5.2 hrs with minimal deep sleep.”

“No immediate concerns.”
do not use * for formatting or bold`;

    const healthContext = `
Last Hour's Health Data:
- Current Heart Rate: ${healthData.current_heart_rate} bpm (Today's avg: ${healthData.avg_heart_rate_today} bpm)
- Current Respiratory Rate: ${healthData.current_respiratory_rate} (Today's avg: ${healthData.avg_respiratory_rate_today})
- HRV: ${healthData.current_hr_variability} ms (10-day avg: ${healthData.avg_hr_variability_10d} ms)
- Last Sleep: ${healthData.total_sleep_last}h (Deep: ${healthData.deep_sleep_last}h)
- Exercise Today: ${healthData.exercise_time_today} minutes
- Current Mood: ${healthData.latest_mood}

Please analyze this data and highlight any concerning patterns or anomalies from the last hour.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: healthContext }
      ],
      temperature: 0.5,  // Lower temperature for more consistent, focused responses
      max_tokens: 100    // Limit response length
    });

    const analysisResult = completion.choices[0].message.content.trim();
    
    // Only save notification if there are concerns
    if (!analysisResult.includes("No immediate concerns")) {
      const saveQuery = `
        INSERT INTO notifications (content)
        VALUES ($1)
        RETURNING id, content, received_at
      `;
      
      const result = await client.query(saveQuery, [analysisResult]);
      
      res.json({ 
        notification: result.rows[0],
        healthStats: healthData
      });
    } else {
      res.json({ 
        notification: null,
        message: "No immediate concerns",
        healthStats: healthData
      });
    }
    
  } catch (err) {
    console.error('Error analyzing health data:', err);
    res.status(500).json({ 
      error: 'Failed to analyze health data', 
      details: err.message 
    });
  } finally {
    client.release();
  }
});
