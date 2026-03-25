#!/usr/bin/env node
/**
 * WanderMap test suite
 * Runs unit tests always; integration tests require ANTHROPIC_API_KEY
 */

const http = require('http');

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label, result, msg) {
  if (result) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${msg ? ': ' + msg : ''}`);
    failed++;
  }
}

function skip(label) {
  console.log(`  - ${label} (skipped – no API key)`);
  skipped++;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function post(path, body, port = 3000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── unit tests (validation logic inline) ─────────────────────────────────────

const VALID_TRANSPORTS = ['flight', 'drive', 'train', 'ship', 'walk', 'other'];
class ValidationError extends Error {}

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

// ── run tests ─────────────────────────────────────────────────────────────────

async function main() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  console.log('\n=== Unit tests: validateTripData ===');

  // Valid input
  let result = validateTripData({
    title: 'NYC to Paris',
    summary: 'A great trip',
    steps: [{ from: 'New York', to: 'Paris', transport: 'flight', notes: '' }]
  });
  ok('valid input passes', result.steps.length === 1);
  ok('transport preserved', result.steps[0].transport === 'flight');

  // Unknown transport falls back to "other"
  result = validateTripData({
    title: 'A trip', summary: 'summary',
    steps: [{ from: 'A', to: 'B', transport: 'teleport', notes: '' }]
  });
  ok('unknown transport → "other"', result.steps[0].transport === 'other');

  // Missing title
  try {
    validateTripData({ title: '', summary: 's', steps: [{ from: 'A', to: 'B', transport: 'drive', notes: '' }] });
    ok('missing title throws', false, 'should have thrown');
  } catch (e) {
    ok('missing title throws ValidationError', e instanceof ValidationError);
  }

  // Empty steps
  try {
    validateTripData({ title: 'T', summary: 's', steps: [] });
    ok('empty steps throws', false, 'should have thrown');
  } catch (e) {
    ok('empty steps throws ValidationError', e instanceof ValidationError);
  }

  // Missing from
  try {
    validateTripData({ title: 'T', summary: 's', steps: [{ from: '', to: 'B', transport: 'drive', notes: '' }] });
    ok('missing from throws', false, 'should have thrown');
  } catch (e) {
    ok('missing "from" throws ValidationError', e instanceof ValidationError);
  }

  // Whitespace trimming
  result = validateTripData({
    title: 'T', summary: 's',
    steps: [{ from: '  New York  ', to: '  London  ', transport: 'flight', notes: '  note  ' }]
  });
  ok('whitespace trimmed from location names', result.steps[0].from === 'New York');
  ok('whitespace trimmed from notes', result.steps[0].notes === 'note');

  // notes defaults to empty string when missing
  result = validateTripData({
    title: 'T', summary: 's',
    steps: [{ from: 'A', to: 'B', transport: 'train', notes: undefined }]
  });
  ok('missing notes defaults to ""', result.steps[0].notes === '');

  if (!hasKey) {
    console.log('\n=== Integration tests (server) ===');
    console.log('  ℹ  ANTHROPIC_API_KEY not set — skipping server tests.');
    console.log('  ℹ  Set it in .env to run full integration tests.');
    skip('/api/parse-trip returns valid trip structure');
    skip('/api/parse-trip returns 400 for empty input');
    skip('/api/parse-trip returns 400 for too-long input');
    skip('/api/geocode-one resolves Paris');
    skip('/api/geocode-one returns found:false for gibberish');
    skip('/api/geocode-one caches result (second call fast)');
  } else {
    console.log('\n=== Integration tests (server on :3000) ===');

    // Check server is up
    let serverUp = false;
    try {
      const r = await post('/api/geocode-one', { location: 'London' });
      serverUp = r.status !== undefined;
    } catch (e) {
      serverUp = false;
    }

    if (!serverUp) {
      console.log('  ✗ Server not reachable on port 3000 — start with: npm start');
      failed++;
    } else {
      // ── /api/parse-trip ──────────────────────────────────────────────────
      console.log('\n  /api/parse-trip');

      // 400 – empty text
      let r = await post('/api/parse-trip', { text: '' });
      ok('empty text → 400', r.status === 400);

      // 400 – too long
      r = await post('/api/parse-trip', { text: 'x'.repeat(5001) });
      ok('text > 5000 chars → 400', r.status === 400);

      // Real parse
      console.log('  (calling Claude API — may take a few seconds)');
      r = await post('/api/parse-trip', { text: 'I flew from New York to London, then took the train to Paris.' });
      ok('real parse → 200', r.status === 200, JSON.stringify(r.body).slice(0, 120));
      if (r.status === 200) {
        ok('has title', typeof r.body.title === 'string' && r.body.title.length > 0);
        ok('has summary', typeof r.body.summary === 'string' && r.body.summary.length > 0);
        ok('has steps array', Array.isArray(r.body.steps) && r.body.steps.length > 0);
        const s = r.body.steps[0];
        ok('step has from/to/transport/notes', s.from && s.to && s.transport && s.notes !== undefined);
        ok('all transports valid', r.body.steps.every(s => VALID_TRANSPORTS.includes(s.transport)));
        console.log(`  → title: "${r.body.title}"`);
        console.log(`  → steps: ${r.body.steps.map(s => `${s.from}→${s.to} (${s.transport})`).join(', ')}`);
      }

      // ── /api/geocode-one ─────────────────────────────────────────────────
      console.log('\n  /api/geocode-one');

      r = await post('/api/geocode-one', {});
      ok('no location → 400', r.status === 400);

      r = await post('/api/geocode-one', { location: 'Paris, France' });
      ok('Paris geocodes', r.status === 200 && r.body.found === true, JSON.stringify(r.body));
      if (r.body.found) ok('Paris lat/lng plausible', Math.abs(r.body.lat - 48.85) < 1 && Math.abs(r.body.lng - 2.35) < 1);

      r = await post('/api/geocode-one', { location: 'xyzzy_no_such_place_12345' });
      ok('gibberish → found:false', r.status === 200 && r.body.found === false);

      // Cache test: same location again should be fast (cache hit)
      const t0 = Date.now();
      r = await post('/api/geocode-one', { location: 'Paris, France' });
      const elapsed = Date.now() - t0;
      ok(`cache hit is fast (<200ms, was ${elapsed}ms)`, r.body.found === true && elapsed < 200);
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(45)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
