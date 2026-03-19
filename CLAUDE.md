# WanderMap

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
POST /api/geocode-one  (called once per unique location, sequentially)
  GET nominatim.openstreetmap.org/search?q=<location>
  1.1s server-side delay between requests (Nominatim ToS)
  In-memory cache: repeated locations are returned instantly, no Nominatim hit
  Returns: { lat, lng, found: true } or { found: false }
        │
        ▼
Frontend renders:
  - Great-circle arcs for flights (curved lines) with animated flowing dashes
  - Straight polylines for drive/train/ship/walk (train/ship have slower dash animations)
  - Color-coded + animated by transport mode (defined in TRANSPORT_CONFIG, single source of truth)
  - Numbered markers for each location
  - Clickable step cards that zoom the map
  - Per-step transport mode dropdown (editable after generation)
  - Legend generated dynamically from TRANSPORT_CONFIG
```

## API Endpoints

### `POST /api/geocode-one`
Resolve a single location name to lat/lng. Used by the frontend for per-location progress updates. Results are cached in-memory; repeated calls for the same name return immediately without hitting Nominatim.

**Request:**
```json
{ "location": "Paris, France" }
```

**Response:**
```json
{ "lat": 48.8566, "lng": 2.3522, "found": true }
```
or `{ "found": false }` if not found.

---

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

**Error codes:**
- `422` — AI returned malformed JSON or failed schema validation
- `500` — unexpected server error (Claude returned no text content, network failure, etc.)

**Limits:** Max 5000 characters input, max 2048 tokens output.

---

### `POST /api/geocode` *(legacy)*
Batch-resolve location names to lat/lng. Not called by the current frontend; kept for external tooling.

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

**Limits:** Max 50 locations per request. Sequential requests with 1.1s delay (Nominatim ToS). Server deduplicates before querying.

## Nominatim Usage Notes

- **Rate limit:** 1 request/second maximum — the server enforces this with 1.1s delays
- **Caching:** Geocode results are cached in-memory for the lifetime of the server process. This avoids redundant Nominatim calls for locations that appear multiple times in a trip.
- **User-Agent:** Required by Nominatim ToS — set to `WanderMap/1.0`
- **No API key needed** — free public service by OpenStreetMap
- **Accuracy:** Very high for cities and well-known places; may fail for obscure locations

## Key Design Decisions

- **`TRANSPORT_CONFIG`** is the single source of truth for transport metadata (color, icon, label, dash pattern, line weight, CSS animation class). The map legend, step card icons, dropdowns, and line styling all derive from it.
- **`ValidationError`** class distinguishes AI schema failures from network/API errors in the parse endpoint — avoids fragile string matching. These return HTTP 422; unexpected server faults return 500.
- **`renderGeneration` counter** prevents stale animation frames from appearing when the user changes transport mode while a previous render is still animating.
- **`TRANSPORT_OPTIONS_HTML`** is pre-computed once at startup; dropdown `selected` state is set via `select.value` after innerHTML assignment, not by per-step string building.
- **`parseAbortController`** (module-level) lets the Cancel button abort an in-flight `/api/parse-trip` fetch mid-request.
- **`geocodeAbortController`** (module-level) ensures only one geocoding session is ever active. Starting a new parse aborts any in-flight geocode loop from the previous parse.
- **`geocodeCache`** (module-level `Map` in server.js) stores Nominatim results for the server's lifetime. Cache hits skip the 1.1s Nominatim delay entirely, which matters for trips that revisit the same city.
- **`.hidden` CSS class** is the standard visibility toggle (not inline `style="display:none"`). Components call `classList.add/remove('hidden')`.
- **`getTotalDistanceLabel()`** extracted as a named helper — keeps the `renderSteps()` template literal clean. Appends `(partial)` when one or more legs could not be geocoded.
- **`showSuccess()` / `showWarn()` / `showError()`** are the three banner helpers. Use `showSuccess` for positive confirmations (e.g. share link copied), `showWarn` for non-fatal notices, `showError` for failures.
- **`AbortSignal.timeout(5000)`** on every Nominatim fetch prevents indefinite hangs on server-side network issues.

## Rate Limiting

Two separate `express-rate-limit` instances are applied per-route to reflect their actual cost:

| Route | Limiter | Limit | Rationale |
|-------|---------|-------|-----------|
| `POST /api/parse-trip` | `parseLimiter` | 5 / min | Claude API calls are expensive |
| `POST /api/geocode-one` | `geocodeLimiter` | 60 / min | Nominatim is free; need headroom for per-location progress |
| `POST /api/geocode` | `geocodeLimiter` | 60 / min | Legacy endpoint; rate-limited for safety |

The server also enforces a 1100 ms delay inside `/api/geocode-one` before forwarding to Nominatim, so the ToS rate limit holds even when callers hit the endpoint directly. Cache hits bypass this delay.

On 429 responses, the server sends standard `RateLimit-*` and `Retry-After` headers. The frontend reads `Retry-After` and surfaces a specific wait time in the error message.

## Known Limitations

- **Transport mode inference:** When a trip description doesn't specify how to travel, Claude makes a reasonable guess (e.g., intercontinental = flight). This can be corrected per-leg using the dropdown in the UI.
- **Obscure locations:** Very small towns or unusual place names may not geocode. A warning is shown for any that fail.
- **Geocoding speed:** With Nominatim's 1 req/sec limit, a trip with 10 unique locations takes ~11 seconds to geocode. Progress is shown per-location during this wait. Repeated locations are instant (cached).
- **Ground routes are straight lines:** Drive/train/ship legs are drawn as straight point-to-point lines, not actual road/rail/sea routes.
- **Distance estimates are straight-line (haversine):** Shown per leg and as a running total. When some legs fail to geocode, the total is marked `(partial)`. Actual travel distance will be higher for ground transport.
- **Duration estimates are approximate:** Based on assumed cruising speeds (flight 850 km/h, train 120 km/h, drive 90 km/h, ship 40 km/h, walk 5 km/h).

## Development

```bash
npm run dev          # Start with nodemon (auto-restarts on file changes)
```

The frontend (`public/index.html`) is served as a static file — edit and refresh the browser directly.

For backend changes, `nodemon` will auto-restart. For frontend changes, just refresh the browser.

## Project Structure

```
wandermap/
├── server.js           # Express backend (parse + geocode endpoints)
├── package.json
├── .env.example        # Environment variable template
├── .gitignore
├── CLAUDE.md           # This file
└── public/
    └── index.html      # Full frontend (map + UI, single file)
```
