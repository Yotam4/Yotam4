require('dotenv').config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nERROR: ANTHROPIC_API_KEY is not set.');
  console.error('Copy .env.example to .env and add your Anthropic API key.\n');
  process.exit(1);
}

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic();

const VALID_TRANSPORTS = ['flight', 'drive', 'train', 'ship', 'walk', 'other'];

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PARSE_SYSTEM_PROMPT = `You are a travel itinerary parser. Given a free-form text description of a trip or journey, extract and return a structured JSON object representing the trip steps.

Rules:
- Identify all locations/destinations mentioned in order
- Determine the transport mode between each pair of locations:
  - "flight" for air travel, flying, plane, fly
  - "drive" for car, road trip, driving, road
  - "train" for train, rail, railway
  - "ship" for cruise, boat, ferry, sail
  - "walk" for walking, hiking, on foot
  - "other" for unspecified or other modes
- For each step, provide: from location, to location, transport mode, and any notes
- Each location should be a real, geocodable place name (city, country, landmark)
- If transport mode is not specified, make a reasonable inference (e.g. intercontinental = flight, nearby cities = drive/train)
- Return ONLY valid JSON, nothing else

Output format:
{
  "title": "Trip title derived from the text",
  "summary": "One-sentence summary of the trip",
  "steps": [
    {
      "from": "City, Country",
      "to": "City, Country",
      "transport": "flight|drive|train|ship|walk|other",
      "notes": "Optional extra detail about this leg"
    }
  ]
}`;

function validateTripData(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid response: not an object');
  if (typeof data.title !== 'string' || !data.title.trim()) throw new Error('Missing or invalid "title"');
  if (typeof data.summary !== 'string') throw new Error('Missing "summary"');
  if (!Array.isArray(data.steps) || data.steps.length === 0) throw new Error('No trip steps found');

  data.steps = data.steps.map((step, i) => {
    if (!step.from || typeof step.from !== 'string' || !step.from.trim())
      throw new Error(`Step ${i + 1} missing "from" location`);
    if (!step.to || typeof step.to !== 'string' || !step.to.trim())
      throw new Error(`Step ${i + 1} missing "to" location`);
    return {
      from: step.from.trim(),
      to: step.to.trim(),
      transport: VALID_TRANSPORTS.includes(step.transport) ? step.transport : 'other',
      notes: typeof step.notes === 'string' ? step.notes.trim() : ''
    };
  });

  return data;
}

app.post('/api/parse-trip', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No trip description provided' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Trip description is too long (max 5000 characters)' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
    }

    const validated = validateTripData(parsed);
    res.json(validated);
  } catch (err) {
    if (err.message.startsWith('Step ') || err.message.startsWith('Missing') || err.message.startsWith('Invalid')) {
      return res.status(500).json({ error: 'AI response was malformed: ' + err.message });
    }
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse trip description. Please try again.' });
  }
});

// Geocode using OpenStreetMap Nominatim (free, accurate, no API key required)
async function geocodeLocation(location) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'World-Trip-Map-Maker/1.0 (https://github.com/world-trip-map-maker)',
      'Accept-Language': 'en'
    }
  });
  if (!res.ok) throw new Error(`Nominatim request failed: ${res.status}`);
  const data = await res.json();
  if (data.length === 0) return { found: false };
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), found: true };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.post('/api/geocode', async (req, res) => {
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'No locations provided' });
  }
  if (locations.length > 50) {
    return res.status(400).json({ error: 'Too many locations (max 50)' });
  }

  const results = {};
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    try {
      results[loc] = await geocodeLocation(loc);
    } catch (err) {
      console.error(`Geocoding failed for "${loc}":`, err.message);
      results[loc] = { found: false };
    }
    // Nominatim ToS: max 1 request per second
    if (i < locations.length - 1) await sleep(1100);
  }

  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`World Trip Map Maker running on http://localhost:${PORT}`));
