require('dotenv').config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nERROR: ANTHROPIC_API_KEY is not set.');
  console.error('Copy .env.example to .env and add your Anthropic API key.\n');
  process.exit(1);
}

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const client = new Anthropic();

const VALID_TRANSPORTS = ['flight', 'drive', 'train', 'ship', 'walk', 'other'];

class ValidationError extends Error {}

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const RATE_LIMIT_MSG = { error: 'Too many requests — please wait a minute and try again.' };
// Claude calls are expensive — strict limit
const parseLimiter = rateLimit({ windowMs: 60_000, max: 5,  standardHeaders: true, legacyHeaders: false, message: RATE_LIMIT_MSG });
// Nominatim is free — higher limit to accommodate per-location progress calls
const geocodeLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, message: RATE_LIMIT_MSG });

const PARSE_SYSTEM_PROMPT = `You are a travel itinerary parser. Given a free-form text description of a trip or journey, extract the trip steps and call the save_trip tool with the structured data.

Rules:
- Identify all locations/destinations mentioned in order
- Determine the transport mode between each pair of locations:
  - "flight" for air travel, flying, plane, fly
  - "drive" for car, road trip, driving, road
  - "train" for train, rail, railway
  - "ship" for cruise, boat, ferry, sail
  - "walk" for walking, hiking, on foot
  - "other" for unspecified or other modes
- Each location should be a real, geocodable place name (city, country, landmark)
- If transport mode is not specified, make a reasonable inference (e.g. intercontinental = flight, nearby cities = drive/train)`;

const TRIP_TOOL = {
  name: 'save_trip',
  description: 'Save the structured trip data extracted from the user description.',
  input_schema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short trip title' },
      summary: { type: 'string', description: 'One-sentence summary of the trip' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from:      { type: 'string', description: 'Departure location' },
            to:        { type: 'string', description: 'Arrival location' },
            transport: { type: 'string', enum: ['flight','drive','train','ship','walk','other'] },
            notes:     { type: 'string', description: 'Optional extra detail' }
          },
          required: ['from', 'to', 'transport', 'notes']
        }
      }
    },
    required: ['title', 'summary', 'steps']
  }
};


function validateTripData(data) {
  if (!data || typeof data !== 'object') throw new ValidationError('Invalid response: not an object');
  if (typeof data.title !== 'string' || !data.title.trim()) throw new ValidationError('Missing or invalid "title"');
  if (typeof data.summary !== 'string' || !data.summary.trim()) throw new ValidationError('Missing "summary"');
  if (!Array.isArray(data.steps) || data.steps.length === 0) throw new ValidationError('No trip steps found');

  data.steps = data.steps.map((step, i) => {
    if (!step.from || typeof step.from !== 'string' || !step.from.trim())
      throw new ValidationError(`Step ${i + 1} missing "from" location`);
    if (!step.to || typeof step.to !== 'string' || !step.to.trim())
      throw new ValidationError(`Step ${i + 1} missing "to" location`);
    return {
      from: step.from.trim(),
      to: step.to.trim(),
      transport: VALID_TRANSPORTS.includes(step.transport) ? step.transport : 'other',
      notes: typeof step.notes === 'string' ? step.notes.trim() : ''
    };
  });

  return data;
}

app.post('/api/parse-trip', parseLimiter, async (req, res) => {
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
      tools: [TRIP_TOOL],
      tool_choice: { type: 'tool', name: 'save_trip' },
      messages: [{ role: 'user', content: text }]
    });

    console.log('AI stop_reason:', message.stop_reason);
    console.log('AI content types:', message.content.map(b => b.type));

    const toolBlock = message.content.find(b => b.type === 'tool_use' && b.name === 'save_trip');
    if (!toolBlock) {
      console.error('No tool_use block in response:', JSON.stringify(message.content));
      return res.status(500).json({ error: 'AI returned an unexpected response. Please try again.' });
    }

    console.log('Tool input:', JSON.stringify(toolBlock.input));
    const validated = validateTripData(toolBlock.input);
    res.json(validated);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error('Validation error:', err.message);
      return res.status(422).json({ error: 'AI response was malformed: ' + err.message });
    }
    console.error('Parse error:', err);
    return res.status(500).json({ error: 'Failed to parse trip description. Please try again.' });
  }
});

// Geocode using OpenStreetMap Nominatim (free, accurate, no API key required)
async function geocodeLocation(location) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: {
      'User-Agent': 'WanderMap/1.0 (https://github.com/wandermap)',
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

const geocodeCache = new Map();

// Batch geocode (kept for compatibility)
app.post('/api/geocode', geocodeLimiter, async (req, res) => {
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'No locations provided' });
  }
  if (locations.length > 50) {
    return res.status(400).json({ error: 'Too many locations (max 50)' });
  }

  const uniqueLocs = [...new Set(locations.filter(l => typeof l === 'string' && l.trim()))];
  const results = {};
  for (let i = 0; i < uniqueLocs.length; i++) {
    const loc = uniqueLocs[i];
    if (geocodeCache.has(loc)) {
      results[loc] = geocodeCache.get(loc);
      continue;
    }
    try {
      const result = await geocodeLocation(loc);
      geocodeCache.set(loc, result);
      results[loc] = result;
    } catch (err) {
      console.error(`Geocoding failed for "${loc}":`, err.message);
      results[loc] = { found: false };
    }
    if (i < uniqueLocs.length - 1) await sleep(1100);
  }

  res.json(results);
});

// Single-location geocode — used by the frontend for per-location progress updates
app.post('/api/geocode-one', geocodeLimiter, async (req, res) => {
  const { location } = req.body;
  if (!location || typeof location !== 'string' || !location.trim()) {
    return res.status(400).json({ error: 'No location provided' });
  }
  const loc = location.trim();
  if (geocodeCache.has(loc)) {
    return res.json(geocodeCache.get(loc));
  }
  try {
    await sleep(1100); // enforce Nominatim ToS server-side (1 req/sec max)
    const result = await geocodeLocation(loc);
    geocodeCache.set(loc, result);
    res.json(result);
  } catch (err) {
    console.error(`Geocoding failed for "${location}":`, err.message);
    res.json({ found: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WanderMap running on http://localhost:${PORT}`));
