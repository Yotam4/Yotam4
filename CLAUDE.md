# World Trip Map Maker

An interactive web app that takes a free-speech description of a trip and renders it as a visual, step-by-step map — showing routes, destinations, and how you travel between them (flight, drive, train, ship, etc.).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| AI Parsing | Claude API (`claude-sonnet-4-6`) |
| Geocoding | OpenStreetMap Nominatim (free, no key needed) |
| Map | Leaflet.js + CartoDB dark tiles |
| Frontend | Vanilla HTML/CSS/JS (no build step) |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set your Anthropic API key:
# ANTHROPIC_API_KEY=sk-ant-...

# 3. Start the server
npm start          # production
npm run dev        # development (hot reload with nodemon)
```

Open http://localhost:3000

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `PORT` | No | `3000` | HTTP port to listen on |

The server will exit at startup with a clear error message if `ANTHROPIC_API_KEY` is not set.

## Architecture & Data Flow

```
User types trip text (max 5000 chars)
        │
        ▼
POST /api/parse-trip
  Claude claude-sonnet-4-6 parses free-speech → structured JSON
  Validates schema: title, summary, steps[]{from, to, transport, notes}
  Sanitizes transport values against allowed list
        │
        ▼
POST /api/geocode
  For each unique location name:
    GET nominatim.openstreetmap.org/search?q=<location>
    Sequential requests (1.1s delay between each, per Nominatim ToS)
  Returns: { "City, Country": { lat, lng, found: true|false } }
        │
        ▼
Frontend renders:
  - Great-circle arcs for flights (curved lines)
  - Straight polylines for drive/train/ship/walk
  - Color-coded by transport mode
  - Numbered markers for each location
  - Clickable step cards that zoom the map
  - Per-step transport mode dropdown (editable after generation)
```

## API Endpoints

### `POST /api/parse-trip`
Parse a free-speech trip description into structured data.

**Request:**
```json
{ "text": "Flying from New York to London, then train to Paris..." }
```

**Response:**
```json
{
  "title": "New York to Paris via London",
  "summary": "A transatlantic journey combining flight and rail travel.",
  "steps": [
    { "from": "New York, USA", "to": "London, UK", "transport": "flight", "notes": "" },
    { "from": "London, UK",    "to": "Paris, France", "transport": "train",  "notes": "" }
  ]
}
```

**Transport values:** `flight` | `drive` | `train` | `ship` | `walk` | `other`

**Limits:** Max 5000 characters input, max 2048 tokens output.

---

### `POST /api/geocode`
Resolve location names to lat/lng using OpenStreetMap Nominatim.

**Request:**
```json
{ "locations": ["New York, USA", "London, UK", "Paris, France"] }
```

**Response:**
```json
{
  "New York, USA": { "lat": 40.7128, "lng": -74.006, "found": true },
  "London, UK":    { "lat": 51.5074, "lng": -0.1278,  "found": true },
  "Nowhere Land":  { "found": false }
}
```

**Limits:** Max 50 locations per request. Sequential requests with 1.1s delay (Nominatim ToS).

## Nominatim Usage Notes

- **Rate limit:** 1 request/second maximum — the server enforces this with 1.1s delays
- **User-Agent:** Required by Nominatim ToS — set to `World-Trip-Map-Maker/1.0`
- **No API key needed** — free public service by OpenStreetMap
- **Accuracy:** Very high for cities and well-known places; may fail for obscure locations

## Known Limitations

- **Transport mode inference:** When a trip description doesn't specify how to travel, Claude makes a reasonable guess (e.g., intercontinental = flight). This can be corrected per-leg using the dropdown in the UI.
- **Obscure locations:** Very small towns or unusual place names may not geocode. A warning is shown for any that fail.
- **Geocoding speed:** With Nominatim's 1 req/sec limit, a trip with 10 unique locations takes ~10 seconds to geocode.
- **No persistence:** Trips are not saved. Refreshing the page clears everything.

## Development

```bash
npm run dev          # Start with nodemon (auto-restarts on file changes)
```

The frontend (`public/index.html`) is served as a static file — edit and refresh the browser directly.

For backend changes, `nodemon` will auto-restart. For frontend changes, just refresh the browser.

## Project Structure

```
world-trip-map-maker/
├── server.js           # Express backend (parse + geocode endpoints)
├── package.json
├── .env.example        # Environment variable template
├── .gitignore
├── CLAUDE.md           # This file
└── public/
    └── index.html      # Full frontend (map + UI, single file)
```
