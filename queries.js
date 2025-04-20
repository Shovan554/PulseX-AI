const queries = {
  steps: {
    today: `
      SELECT COALESCE(SUM(value), 0) as total_steps
      FROM health_realtime
      WHERE metric_name = 'step_count'
        AND timestamp::date = CURRENT_DATE;
    `
  },
  
  heartRate: {
    current: `
      SELECT
        value        AS latest_heart_rate,
        timestamp    AS reading_time
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
      ORDER BY timestamp DESC
      LIMIT 1;
    `,
    
    dailyRange: `
      SELECT
        MIN(value)    AS min_heart_rate,
        MAX(value)    AS max_heart_rate
      FROM health_realtime
      WHERE metric_name = 'heart_rate'
        AND timestamp::date = CURRENT_DATE;
    `
  },
  
  respiratoryRate: {
    current: `
      SELECT
        value           AS current_resp_rate,
        timestamp       AS reading_time
      FROM health_realtime
      WHERE metric_name    = 'respiratory_rate'
        AND timestamp::date = CURRENT_DATE
      ORDER BY timestamp DESC
      LIMIT 1;
    `,
    
    dailyAverage: `
      SELECT
        AVG(value)      AS avg_resp_rate_today
      FROM health_realtime
      WHERE metric_name    = 'respiratory_rate'
        AND timestamp::date = CURRENT_DATE;
    `
  },
  
  timeInDaylight: {
    weeklyStats: `
      SELECT
        timestamp::date    AS day,
        SUM(value)         AS total_minutes,
        SUM(value) * 60    AS total_seconds,
        SUM(value) / 60.0  AS total_hours
      FROM health_aggregated
      WHERE metric_name = 'time_in_daylight'
        AND timestamp::date BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
      GROUP BY day
      ORDER BY day;
    `
  },
  
  activeEnergy: {
    weeklyStats: `
      SELECT
        hr.timestamp::date    AS day,
        SUM(value)            AS active_energy_kcal
      FROM health_realtime hr
      WHERE metric_name = 'active_energy'
        AND hr.timestamp::date >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY day
      ORDER BY day ASC;
    `
  },
  
  exerciseAndHeartRate: {
    weeklyStats: `
      SELECT
        timestamp::date AS day,
        SUM(value) FILTER (
          WHERE metric_name = 'apple_exercise_time'
            AND timestamp::date BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
        ) AS daily_exercise_minutes,
        AVG(value) FILTER (
          WHERE metric_name = 'resting_heart_rate'
            AND timestamp::date BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
        ) AS daily_avg_resting_hr
      FROM health_aggregated
      WHERE metric_name IN ('apple_exercise_time','resting_heart_rate')
        AND timestamp::date BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
      GROUP BY day
      ORDER BY day;
    `
  },
  
  trends: {
    weeklyComparison: `
      WITH
      -- Current week metrics
      current_week AS (
        SELECT
          SUM(CASE WHEN metric_name = 'step_count' THEN value ELSE 0 END) as steps,
          SUM(CASE WHEN metric_name = 'active_energy' THEN value ELSE 0 END) as energy,
          AVG(CASE WHEN metric_name = 'heart_rate' THEN value ELSE null END) as heart_rate
        FROM health_realtime
        WHERE timestamp >= date_trunc('week', CURRENT_DATE)
      ),
      -- Previous week metrics
      previous_week AS (
        SELECT
          SUM(CASE WHEN metric_name = 'step_count' THEN value ELSE 0 END) as steps,
          SUM(CASE WHEN metric_name = 'active_energy' THEN value ELSE 0 END) as energy,
          AVG(CASE WHEN metric_name = 'heart_rate' THEN value ELSE null END) as heart_rate
        FROM health_realtime
        WHERE timestamp >= date_trunc('week', CURRENT_DATE - interval '1 week')
          AND timestamp < date_trunc('week', CURRENT_DATE)
      ),
      -- Current week sleep
      current_sleep AS (
        SELECT COALESCE(
          SUM(EXTRACT(epoch FROM (sleep_end - sleep_start)) / 3600.0),
          0
        ) as total_hours
        FROM sleep_analysis
        WHERE sleep_start >= date_trunc('week', CURRENT_DATE)
      ),
      -- Previous week sleep
      previous_sleep AS (
        SELECT COALESCE(
          SUM(EXTRACT(epoch FROM (sleep_end - sleep_start)) / 3600.0),
          0
        ) as total_hours
        FROM sleep_analysis
        WHERE sleep_start >= date_trunc('week', CURRENT_DATE - interval '1 week')
          AND sleep_start < date_trunc('week', CURRENT_DATE)
      )
      -- Final calculation
      SELECT
        cw.steps as steps_current,
        pw.steps as steps_previous,
        CASE 
          WHEN pw.steps = 0 THEN 0 
          ELSE ((cw.steps - pw.steps) / pw.steps * 100) 
        END as steps_pct_change,
        
        cw.energy as energy_current,
        pw.energy as energy_previous,
        CASE 
          WHEN pw.energy = 0 THEN 0 
          ELSE ((cw.energy - pw.energy) / pw.energy * 100) 
        END as energy_pct_change,
        
        cw.heart_rate as heart_rate_current,
        pw.heart_rate as heart_rate_previous,
        CASE 
          WHEN pw.heart_rate = 0 THEN 0 
          ELSE ((cw.heart_rate - pw.heart_rate) / pw.heart_rate * 100) 
        END as heart_rate_pct_change,
        
        cs.total_hours as sleep_current,
        ps.total_hours as sleep_previous,
        CASE 
          WHEN ps.total_hours = 0 THEN 0 
          ELSE ((cs.total_hours - ps.total_hours) / ps.total_hours * 100) 
        END as sleep_pct_change
      FROM current_week cw
      CROSS JOIN previous_week pw
      CROSS JOIN current_sleep cs
      CROSS JOIN previous_sleep ps
    `
  },
  healthStats: {
    recentStats: `
      WITH recent_metrics AS (
        SELECT 
          metric_name,
          value,
          timestamp,
          ROW_NUMBER() OVER (PARTITION BY metric_name ORDER BY timestamp DESC) as rn
        FROM health_aggregated
        WHERE metric_name IN ('headphone_audio_exposure', 'resting_heart_rate')
          AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
      ),
      avg_metrics AS (
        SELECT 
          metric_name,
          AVG(value) as avg_value
        FROM health_aggregated
        WHERE metric_name IN ('headphone_audio_exposure', 'resting_heart_rate')
          AND timestamp >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY metric_name
      )
      SELECT 
        json_build_object(
          'recent_audio_exposure', (SELECT value FROM health_aggregated ha WHERE metric_name = 'headphone_audio_exposure' ),
          'avg_audio_exposure', (SELECT avg_value FROM avg_metrics WHERE metric_name = 'headphone_audio_exposure'),
          'recent_resting_hr', (SELECT value FROM recent_metrics WHERE metric_name = 'resting_heart_rate' AND rn = 1),
          'avg_resting_hr', (SELECT avg_value FROM avg_metrics WHERE metric_name = 'resting_heart_rate')
        ) as stats
    `
  }
};

module.exports = queries;
