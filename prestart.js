const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    console.warn(`[prestart] ${label} was already applied or the source changed.`);
    return source;
  }
  console.log(`[prestart] Applied ${label}.`);
  return source.replace(search, replacement);
}

try {
  let source = fs.readFileSync(serverPath, 'utf8');

  source = source.split('chriskraichgit').join('jameswodzinskigit');

  source = replaceOnce(
    source,
    "const apiKey = process.env.GOOGLE_MAPS_API_KEY;",
    "const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY || process.env.MAPS_API_KEY;",
    'Google Maps/Places secret aliases'
  );

  source = replaceOnce(
    source,
    "if (!apiKey) { jsonResponse(res, 200, { error: 'GOOGLE_MAPS_API_KEY not set', reviews: [] }); return; }",
    "if (!apiKey) { jsonResponse(res, 503, { error: 'Google Maps API key is not configured. Add GOOGLE_MAPS_API_KEY in Replit Secrets.', reviews: [] }); return; }",
    'clear missing-key error'
  );

  source = replaceOnce(
    source,
    "const accountData = ACCOUNT_PLACE_IDS[account];",
    "const normalizedAccount = String(account).toLowerCase().replace(/[^a-z0-9@.]/g, '');\n  const accountData = ACCOUNT_PLACE_IDS[account] || ACCOUNT_PLACE_IDS[normalizedAccount] || (normalizedAccount === 'greencollar' ? { placeId: 'ChIJJ8-biosyw4kR738ilrfxrbU', name: 'Green Collar Roofing & Exteriors' } : null);",
    'account key normalization'
  );

  source = replaceOnce(
    source,
    "const result = r.result || {};",
    "if (r.status !== 'OK') {\n      const detail = r.error_message || r.status || 'UNKNOWN_ERROR';\n      jsonResponse(res, 502, { error: 'Google Places request failed: ' + detail, reviews: [] });\n      return;\n    }\n    const result = r.result || {};",
    'Google Places API error reporting'
  );

  source = replaceOnce(
    source,
    "jsonResponse(res, 200, { mapsKey: process.env.GOOGLE_MAPS_API_KEY || '' });",
    "jsonResponse(res, 200, { mapsKey: process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY || process.env.MAPS_API_KEY || '' });",
    'client config secret aliases'
  );

  fs.writeFileSync(serverPath, source);
  console.log('[prestart] Repository and Google Places compatibility checks complete.');
} catch (error) {
  console.error('[prestart] Startup validation failed:', error.message);
  process.exit(1);
}
