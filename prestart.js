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

  fs.writeFileSync(serverPath, server);

  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');

    html = replaceOnce(
      html,
      "if (!savedAcctId && payload.accounts && payload.accounts[0]) {\n                // accounts array has server keys — map first one to a1\n                savedAcctId = 'a1';\n              }",
      "if (!savedAcctId && payload.accounts && payload.accounts.length === 1 && payload.calRole !== 'superadmin' && payload.role !== 'superadmin' && payload.role !== 'agency') {\n                var onlyKey = payload.accounts[0];\n                var match = (window.DEFAULT_ACCOUNTS || []).find(function(a){ return a.serverKey === onlyKey; });\n                savedAcctId = match ? match.id : null;\n              }",
      'prevent automatic Apex selection for master users'
    );

    html = replaceAll(
      html,
      "refreshTenantContext(acctId || 'a1');",
      "if (acctId) refreshTenantContext(acctId);",
      'remove forced Apex tenant restore'
    );

    html = replaceAll(
      html,
      "setCurrentAcct(acctId || 'a1');",
      "if (acctId) setCurrentAcct(acctId);",
      'remove forced Apex account selection'
    );

    html = replaceAll(
      html,
      "refreshTenantContext(savedId||'a1');",
      "if (savedId) refreshTenantContext(savedId);",
      'remove forced Apex fallback during launch'
    );

    html = replaceAll(
      html,
      "setCurrentAcct(savedId||'a1');",
      "if (savedId) setCurrentAcct(savedId);",
      'remove forced Apex fallback account'
    );

    html = replaceOnce(
      html,
      "try { localStorage.removeItem('cal-meta-session-token'); } catch(e){}\n          }\n        }\n      } catch(e) {}",
      "try { localStorage.removeItem('cal-meta-session-token'); } catch(e){}\n          }\n        }\n      } catch(e) { console.warn('CAL bootstrap token validation failed', e); }",
      'avoid silent bootstrap failure'
    );

    fs.writeFileSync(indexPath, html);
  }

  console.log('[prestart] CAL OS startup, login, and account-selection safeguards complete.');
} catch (error) {
  console.error('[prestart] Startup validation failed:', error.message);
  process.exit(1);
}
