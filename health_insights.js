// To eliminate the MODULE_TYPELESS_PACKAGE_JSON warning,
// add "type": "module" to your package.json.

import OpenAI from "openai";
import { fileURLToPath } from 'url';
 
// Directly assign your API key here
const openai = new OpenAI({
  apiKey: "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"
});

/**
 * Generate empathetic health insights from the provided metrics.
 * @param {Object} healthReport - Latest health report JSON object
 * @returns {Promise<string>} AI-generated suggestions
 */
export async function getHealthInsights(healthReport) {
  const systemMessage = {
    role: "system",
    content: `You are a warm, compassionate AI health companion—part therapist, part friend. 
Whenever you receive a JSON object of health metrics, you’ll respond in a relaxed, conversational tone (no bullet points). 
Notice anything that stands out—like a fast heart rate, low sleep, or low energy—and fold your advice into a gentle, friendly sentence.
For example: “It looks like you didn’t get enough rest last night—how about squeezing in a quick nap this afternoon?
 or “Your heart rate is a bit higher than usual; maybe pause for a few deep breaths and a glass of water.”`
  };

  const userMessage = {
    role: "user",
    content: `Here is the latest health report:\n${JSON.stringify(healthReport, null, 2)}\n\nPlease give your insights and recommendations.`
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [systemMessage, userMessage],
    temperature: 0.7,
    max_tokens: 250
  });

  return completion.choices[0].message.content.trim();
}

// Example usage
async function main() {
  const sampleReport = {
    current_heart_rate: 84,
    avg_heart_rate_today: 90.5,
    current_respiratory_rate: 24,
    avg_respiratory_rate_today: null,
    current_hr_variability: 35.5,
    avg_hr_variability_10d: 49.1,
    current_sleeping_temperature: 97.0,
    avg_sleeping_temperature_7d: 97.1,
    current_audio_exposure: 45.6,
    avg_audio_exposure_7d: 47.8,
    total_sleep_last: 4.28,
    deep_sleep_last: 1.22,
    rem_sleep_last: 0.93,
    total_steps_today: 528,
    exercise_time_today: 1,
    time_in_daylight_today: 0,
    latest_mood : "🙂"
  };

  try {
    const advice = await getHealthInsights(sampleReport);
    console.log("AI Suggestions:\n", advice);
  } catch (err) {
    console.error("Error fetching health insights:", err);
  }
}

// Run if this file is executed directly as an ES module
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}
