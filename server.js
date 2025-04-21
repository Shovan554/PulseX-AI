const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pool = require('./db');
const queries = require('./queries');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

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
    const query = queries.respiratoryRate.current;
    const result = await pool.query(query);
    res.json(result.rows[0] || { current_resp_rate: null, reading_time: null });
  } catch (err) {
    console.error('Error fetching current respiratory rate:', err);
    res.status(500).json({ error: 'Failed to fetch respiratory rate data' });
  }
});

app.get('/api/respiratory-rate/daily-average', async (req, res) => {
  try {
    const query = queries.respiratoryRate.dailyAverage;
    const result = await pool.query(query);
    res.json(result.rows[0] || { avg_resp_rate_today: null });
  } catch (err) {
    console.error('Error fetching average respiratory rate:', err);
    res.status(500).json({ error: 'Failed to fetch average respiratory rate data' });
  }
});

// Time in daylight endpoint
app.get('/api/daylight/weekly', async (req, res) => {
  try {
    const query = queries.timeInDaylight.weeklyStats;
    const result = await pool.query(query);
    
    // Calculate average excluding today if today's data exists
    const today = new Date().toISOString().split('T')[0];
    const todayData = result.rows.find(row => row.day.toISOString().split('T')[0] === today);
    const previousDays = result.rows.filter(row => row.day.toISOString().split('T')[0] !== today);
    
    const avgMinutes = previousDays.length > 0
      ? previousDays.reduce((sum, day) => sum + parseFloat(day.total_minutes), 0) / previousDays.length
      : 0;

    res.json({
      today: todayData?.total_minutes || 0,
      weeklyAverage: Math.round(avgMinutes),
      dailyData: result.rows
    });
  } catch (err) {
    console.error('Error fetching daylight data:', err);
    res.status(500).json({ error: 'Failed to fetch daylight data' });
  }
});

// Sleep average endpoint
app.get('/api/sleep/weekly-average', async (req, res) => {
  try {
    const query = `
      SELECT
        ROUND(
          AVG(
            EXTRACT(EPOCH FROM (sleep_end - sleep_start)) / 3600.0
            ::numeric
          )
        , 2) AS average
      FROM sleep_analysis
      WHERE record_date >= CURRENT_DATE - INTERVAL '6 days'`;
    
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
        ROUND(
          EXTRACT(EPOCH FROM (sleep_end - sleep_start)) / 3600.0
          ::numeric
        , 2) AS total_sleep_hours,
        ROUND(deep   ::numeric, 2) AS deep_sleep_hours,
        ROUND(core   ::numeric, 2) AS core_sleep_hours,
        ROUND(rem    ::numeric, 2) AS rem_sleep_hours
      FROM sleep_analysis
      ORDER BY record_date DESC
      LIMIT 1`;
    
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
          ROUND(
            EXTRACT(EPOCH FROM (sa.sleep_end - sa.sleep_start)) / 3600.0
            ::numeric
          , 2
        ), 0) AS total_sleep_hours,
        sa.sleep_start,
        sa.sleep_end,
        COALESCE(ROUND(sa.deep::numeric, 2), 0) AS deep_sleep_hours,
        COALESCE(ROUND(sa.core::numeric, 2), 0) AS core_sleep_hours,
        COALESCE(ROUND(sa.rem::numeric, 2), 0) AS rem_sleep_hours,
        COALESCE(ROUND(sa.awake::numeric, 2), 0) AS awake_hours
      FROM date_range dr
      LEFT JOIN sleep_analysis sa ON dr.date = sa.record_date
      ORDER BY dr.date ASC;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching weekly timeline:', err);
    res.status(500).json({ error: 'Failed to fetch weekly timeline' });
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
    res.json(result.rows[0] || { value: null, timestamp: null });
  } catch (err) {
    console.error('Error fetching headphone exposure data:', err);
    res.status(500).json({ error: 'Failed to fetch headphone exposure data' });
  }
});

// Weekly trends endpoint
app.get('/api/trends/weekly', async (req, res) => {
  const client = await pool.connect();
  try {
    const weeklyQuery = `
      WITH 
      -- Sleep data by week
      sleep_week AS (
        SELECT
          date_trunc('week', sleep_start::date)::date AS week_start,
          SUM(EXTRACT(epoch FROM (sleep_end - sleep_start))) / 3600.0 AS total_sleep_hrs
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
      
      -- Calculate final results with percentage changes
      SELECT json_build_object(
        'sleep_current', ROUND(sleep_current::numeric, 2),
        'sleep_previous', ROUND(sleep_previous::numeric, 2),
        'sleep_pct_change', ROUND(((sleep_current - sleep_previous) / NULLIF(sleep_previous, 0) * 100)::numeric, 2),
        
        'heart_rate_current', heart_rate_current,
        'heart_rate_previous', heart_rate_previous,
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
      -- Daily sleep metrics
      sleep_metrics AS (
        SELECT
          COALESCE(
            (SELECT SUM(EXTRACT(epoch FROM (sleep_end - sleep_start))) / 3600.0
             FROM sleep_analysis
             WHERE sleep_start::date = CURRENT_DATE),
            0
          ) as current_sleep,
          COALESCE(
            (SELECT SUM(EXTRACT(epoch FROM (sleep_end - sleep_start))) / 3600.0
             FROM sleep_analysis
             WHERE sleep_start::date = CURRENT_DATE - INTERVAL '1 day'),
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
        'sleep_pct_change', ROUND(((s.current_sleep - s.previous_sleep) / NULLIF(s.previous_sleep, 0) * 100)::numeric, 2),
        
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
          ROUND(AVG(value)::numeric, 0) as recent_resting_hr
        FROM health_aggregated 
        WHERE metric_name = 'resting_heart_rate'
          AND timestamp >= CURRENT_DATE - INTERVAL '24 hours'
      ),
      audio_exposure AS (
        SELECT 
          ROUND(AVG(value)::numeric, 0) as recent_audio_exposure
        FROM health_aggregated 
        WHERE metric_name = 'headphone_audio_exposure'
          AND timestamp >= CURRENT_DATE - INTERVAL '24 hours'
      )
      SELECT json_build_object(
        'recent_resting_hr', hr.recent_resting_hr,
        'avg_resting_hr', (
          SELECT ROUND(AVG(value)::numeric, 0)
          FROM health_aggregated 
          WHERE metric_name = 'resting_heart_rate'
            AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
        ),
        'recent_audio_exposure', ae.recent_audio_exposure,
        'avg_audio_exposure', (
          SELECT ROUND(AVG(value)::numeric, 0)
          FROM health_aggregated 
          WHERE metric_name = 'headphone_audio_exposure'
            AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
        )
      ) as stats
      FROM heart_rate_stats hr, audio_exposure ae;
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

    // Get recent metrics with ROUND to ensure integer values
    const metricsQuery = `
      WITH recent_metrics AS (
        SELECT ROUND(value)::integer as heart_rate
        FROM health_realtime
        WHERE metric_name = 'heart_rate'
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      daily_energy AS (
        SELECT ROUND(COALESCE(SUM(value), 0))::integer as energy_burnt
        FROM health_realtime
        WHERE metric_name = 'active_energy'
          AND timestamp::date = CURRENT_DATE
      ),
      latest_sleep AS (
        SELECT ROUND(asleep)::integer as total_sleep
        FROM sleep_analysis
        WHERE record_date = CURRENT_DATE - INTERVAL '1 day'
        LIMIT 1
      )
      SELECT 
        (SELECT heart_rate FROM recent_metrics) as recent_heart_rate,
        (SELECT energy_burnt FROM daily_energy) as energy_burnt,
        (SELECT total_sleep FROM latest_sleep) as total_sleep
    `;

    const metricsResult = await client.query(metricsQuery);
    const metrics = metricsResult.rows[0];

    // Insert mood with metrics
    const insertQuery = `
      INSERT INTO mental_health (
        mood, 
        recent_heart_rate, 
        energy_burnt, 
        total_sleep
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *`;
    
    const result = await client.query(insertQuery, [
      mood,
      Math.round(metrics.recent_heart_rate || 0),
      Math.round(metrics.energy_burnt || 0),
      Math.round(metrics.total_sleep || 0)
    ]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Detailed error:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      detail: err.detail
    });
    res.status(500).json({ error: 'Failed to log mental health data' });
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

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
