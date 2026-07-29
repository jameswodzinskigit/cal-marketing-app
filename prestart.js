const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const serverPath = path.join(__dirname, 'server.js');
const indexPath = path.join(__dirname, 'index.html');
const secretFile = path.join(__dirname, '.cal-meta-secret');

function replaceAll(source, search, replacement, label) {
  if (!source.includes(search)) {
    console.warn(`[prestart] ${label} already applied or source changed.`);
    return source;
  }
  console.log(`[prestart] Applied ${label}.`);
  return source.split(search).join(replacement);
}

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    console.warn(`[prestart] ${label} already applied or source changed.`);
    return source;
  }
  console.log(`[prestart] Applied ${label}.`);
  return source.replace(search, replacement);
}

function ensurePersistentMetaSecret() {
  if (process.env.CAL_META_SECRET || fs.existsSync(secretFile)) return;
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  console.log('[prestart] Created persistent local CAL_META_SECRET file.');
}

try {
  ensurePersistentMetaSecret();

  let server = fs.readFileSync(serverPath, 'utf8');
  server = server.split('chriskraichgit').join('jameswodzinskigit');

  server = replaceOnce(
    server,
    "const META_SECRET = process.env.CAL_META_SECRET || crypto.randomBytes(32).toString('hex');",
    "const META_SECRET = process.env.CAL_META_SECRET || fs.readFileSync(path.join(__dirname, '.cal-meta-secret'), 'utf8').trim();",
    'persistent CAL session signing secret'
  );

  server = replaceOnce(
    server,
    "const apiKey = process.env.GOOGLE_MAPS_API_KEY;",
    "const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY || process.env.MAPS_API_KEY;",
    'Google Maps/Places secret aliases'
  );

  server = replaceOnce(
    server,
    "if (!apiKey) { jsonResponse(res, 200, { error: 'GOOGLE_MAPS_API_KEY not set', reviews: [] }); return; }",
    "if (!apiKey) { jsonResponse(res, 503, { error: 'Google Maps API key is not configured. Add GOOGLE_MAPS_API_KEY in Replit Secrets.', reviews: [] }); return; }",
    'clear missing-key error'
  );

  server = replaceOnce(
    server,
    "jsonResponse(res, 200, { mapsKey: process.env.GOOGLE_MAPS_API_KEY || '' });",
    "jsonResponse(res, 200, { mapsKey: process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY || process.env.MAPS_API_KEY || '' });",
    'client config secret aliases'
  );

  const duplicateStatusChecks = "    if (r.status !== 'OK') {\n      const detail = r.error_message || r.status || 'UNKNOWN_ERROR';\n      jsonResponse(res, 502, { error: 'Google Places request failed: ' + detail, reviews: [] });\n      return;\n    }\n    if (r.status !== 'OK') {\n      const detail = r.error_message || r.status || 'UNKNOWN_ERROR';\n      jsonResponse(res, 502, { error: 'Google Places request failed: ' + detail, reviews: [] });\n      return;\n    }\n    if (r.status !== 'OK') {\n      const detail = r.error_message || r.status || 'UNKNOWN_ERROR';\n      jsonResponse(res, 502, { error: 'Google Places request failed: ' + detail, reviews: [] });\n      return;\n    }";
  const singleStatusCheck = "    if (r.status !== 'OK') {\n      const detail = r.error_message || r.status || 'UNKNOWN_ERROR';\n      jsonResponse(res, 502, { error: 'Google Places request failed: ' + detail, reviews: [] });\n      return;\n    }";
  server = replaceOnce(server, duplicateStatusChecks, singleStatusCheck, 'remove duplicate Google Places status checks');

  server = replaceOnce(
    server,
    "      store['reviews_cache_' + account] = reviews.map(r => ({ ...r, date: r.time ? new Date(r.time * 1000).toISOString() : null }));\n      store['reviews_cache_meta_' + account] = { rating: out.rating, total: out.total, name: out.name, cachedAt: new Date().toISOString() };",
    "      const incoming = reviews.map(r => ({ ...r, date: r.time ? new Date(r.time * 1000).toISOString() : null }));\n      const existing = Array.isArray(store['reviews_cache_' + account]) ? store['reviews_cache_' + account] : [];\n      const merged = new Map();\n      existing.concat(incoming).forEach(function(review) {\n        const key = [review.time || review.date || '', review.author_name || '', review.rating || '', review.text || ''].join('|');\n        merged.set(key, review);\n      });\n      store['reviews_cache_' + account] = Array.from(merged.values()).sort(function(a, b) {\n        return new Date(b.date || 0) - new Date(a.date || 0);\n      }).slice(0, 1000);\n      const previousMeta = store['reviews_cache_meta_' + account] || {};\n      const snapshots = Array.isArray(previousMeta.snapshots) ? previousMeta.snapshots : [];\n      snapshots.push({ total: out.total, rating: out.rating, capturedAt: new Date().toISOString() });\n      store['reviews_cache_meta_' + account] = { rating: out.rating, total: out.total, name: out.name, cachedAt: new Date().toISOString(), snapshots: snapshots.slice(-365) };",
    'preserve Google review history and totals snapshots'
  );

  server = replaceOnce(
    server,
    "  const account = qs.account || payload.email;\n  const store = loadMetaStore();\n  const cards = store[`nfc_cards_${account}`] || [];",
    "  const account = qs.account || payload.email;\n  if (!isKeyAllowed(account, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN' }); return; }\n  const store = loadMetaStore();\n  const cards = store[`nfc_cards_${account}`] || [];",
    'protect NFC card reads by tenant'
  );

  server = replaceOnce(
    server,
    "  const account = qs.account || payload.email;\n  try {\n    const tapLog = path.join(__dirname, '.nfc-taps.json');",
    "  const account = qs.account || payload.email;\n  if (!isKeyAllowed(account, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN', taps: [], stats: {} }); return; }\n  try {\n    const tapLog = path.join(__dirname, '.nfc-taps.json');",
    'protect NFC tap reads by tenant'
  );

  server = replaceOnce(
    server,
    "  const acct = account || payload.email;\n  const store = loadMetaStore();",
    "  const acct = account || payload.email;\n  if (!isKeyAllowed(acct, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN' }); return; }\n  const store = loadMetaStore();",
    'protect NFC card creation by tenant'
  );

  server = replaceOnce(
    server,
    "  const account = body.account || payload.email;\n  const name = (body.name || '').trim();",
    "  const account = body.account || payload.email;\n  if (!isKeyAllowed(account, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN' }); return; }\n  const name = (body.name || '').trim();",
    'protect NFC card deletion by tenant'
  );

  server = replaceOnce(
    server,
    "  const accountId = qs.accountId || qs.account || payload.email;\n  const cardId = qs.cardId || '';",
    "  const accountId = qs.accountId || qs.account || payload.email;\n  if (!isKeyAllowed(accountId, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN' }); return; }\n  const cardId = qs.cardId || '';",
    'protect NFC stats by tenant'
  );

  server = replaceOnce(
    server,
    "  const account = qs.account || payload.email;\n  const period = qs.period || 'month';",
    "  const account = qs.account || payload.email;\n  if (!isKeyAllowed(account, payload)) { jsonResponse(res, 403, { error: 'FORBIDDEN' }); return; }\n  const period = qs.period || 'month';",
    'protect driver stats by tenant'
  );

  fs.writeFileSync(serverPath, server);

  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');

    html = replaceOnce(
      html,
      "if (!savedAcctId && payload.accounts && payload.accounts[0]) {\n                // accounts array has server keys — map first one to a1\n                savedAcctId = 'a1';\n              }",
      "if (!savedAcctId && payload.accounts && payload.accounts.length === 1 && payload.calRole !== 'superadmin' && payload.role !== 'superadmin' && payload.role !== 'agency') {\n                var onlyKey = payload.accounts[0];\n                var match = (window.DEFAULT_ACCOUNTS || []).find(function(a){ return a.serverKey === onlyKey; });\n                savedAcctId = match ? match.id : null;\n              }",
      'prevent automatic Apex selection for master users'
    );

    html = replaceAll(html, "refreshTenantContext(acctId || 'a1');", "if (acctId) refreshTenantContext(acctId);", 'remove forced Apex tenant restore');
    html = replaceAll(html, "setCurrentAcct(acctId || 'a1');", "if (acctId) setCurrentAcct(acctId);", 'remove forced Apex account selection');
    html = replaceAll(html, "refreshTenantContext(savedId||'a1');", "if (savedId) refreshTenantContext(savedId);", 'remove forced Apex fallback during launch');
    html = replaceAll(html, "setCurrentAcct(savedId||'a1');", "if (savedId) setCurrentAcct(savedId);", 'remove forced Apex fallback account');

    html = replaceOnce(
      html,
      "try { localStorage.removeItem('cal-meta-session-token'); } catch(e){}\n          }\n        }\n      } catch(e) {}",
      "try { localStorage.removeItem('cal-meta-session-token'); } catch(e){}\n          }\n        }\n      } catch(e) { console.warn('CAL bootstrap token validation failed', e); }",
      'avoid silent bootstrap failure'
    );

    fs.writeFileSync(indexPath, html);
  }

  console.log('[prestart] CAL OS startup, reviews, NFC, and tenant safeguards complete.');
} catch (error) {
  console.error('[prestart] Startup validation failed:', error.message);
  process.exit(1);
}
