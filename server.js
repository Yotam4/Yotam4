require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic();

app.use(express.json());
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

app.post('/api/parse-trip', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No trip description provided' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    });

    const raw = message.content[0].text.trim();
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse trip description', detail: err.message });
  }
});

app.post('/api/geocode', async (req, res) => {
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'No locations provided' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Return a JSON object mapping each of these location names to their approximate latitude and longitude coordinates. Only return valid JSON, nothing else.

Locations: ${JSON.stringify(locations)}

Format:
{
  "Location Name": { "lat": 0.0, "lng": 0.0 },
  ...
}`
      }]
    });

    const raw = message.content[0].text.trim();
    const coords = JSON.parse(raw);
    res.json(coords);
  } catch (err) {
    console.error('Geocode error:', err);
    res.status(500).json({ error: 'Failed to geocode locations', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`World Trip Map Maker running on http://localhost:${PORT}`));
