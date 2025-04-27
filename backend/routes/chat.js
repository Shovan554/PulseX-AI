const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { pool } = require('../db'); // Make sure to import your database pool

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

router.post('/chat', async (req, res) => {
  const client = await pool.connect();
  try {
    const { messages, message } = req.body;
    
    // Fetch current health stats
    const healthStats = await client.query(queries.getCurrentHealthStats);
    const healthData = healthStats.rows[0].health_report;
    
    // Add health context to the last user message
    const messagesWithHealth = [...messages];
    messagesWithHealth[messagesWithHealth.length - 1].content = `
User's message: ${message}

Current Health Context:
- Heart Rate: ${healthData.current_heart_rate} bpm (Today's avg: ${healthData.avg_heart_rate_today} bpm)
- Respiratory Rate: ${healthData.current_respiratory_rate} (Today's avg: ${healthData.avg_respiratory_rate_today})
- Heart Rate Variability: ${healthData.current_hr_variability} (10-day avg: ${healthData.avg_hr_variability_10d})
- Last Sleep Duration: ${healthData.total_sleep_last} hours (Deep: ${healthData.deep_sleep_last}h, REM: ${healthData.rem_sleep_last}h)
- Steps Today: ${healthData.total_steps_today}
- Exercise Time Today: ${healthData.exercise_time_today} minutes
- Daylight Exposure Today: ${healthData.time_in_daylight_today} minutes
- Current Mood: ${healthData.latest_mood}
    `;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messagesWithHealth,
      temperature: 0.7,
      max_tokens: 500
    });

    res.json({ 
      response: completion.choices[0].message.content.trim(),
      healthStats: healthData
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to get AI response' });
  } finally {
    client.release();
  }
});

module.exports = router;
