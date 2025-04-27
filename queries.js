const queries = {
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
  }
};

module.exports = queries;
