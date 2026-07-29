const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_MAPS_API_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function database(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const detail = typeof body === "object" && body
      ? (body as Record<string, string>).message || (body as Record<string, string>).hint
      : text;
    throw new Error(`Database ${response.status}: ${detail || "request failed"}`);
  }
  return body;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToHex(buffer);
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function routePath(url: URL) {
  const marker = "/cal-api";
  const position = url.pathname.indexOf(marker);
  return position >= 0 ? url.pathname.slice(position + marker.length) || "/" : url.pathname;
}

function queryValue(value: string) {
  return encodeURIComponent(value);
}

async function bodyJson(req: Request) {
  try { return await req.json(); } catch { return {}; }
}

function ipAddress(req: Request) {
  return (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown")
    .split(",")[0].trim();
}

type Session = {
  id: string;
  role: "agency" | "client" | "driver";
  display_name: string;
  company_id: string | null;
  account_key: string | null;
  company_name: string | null;
};

async function sessionFor(req: Request): Promise<Session | null> {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const tokenHash = await sha256(token);
  const rows = await database(
    `cal_sessions?select=id,role,display_name,company_id&token_hash=eq.${tokenHash}&revoked_at=is.null&expires_at=gt.${queryValue(new Date().toISOString())}&limit=1`,
  ) as Array<Record<string, string | null>>;
  const row = rows?.[0];
  if (!row) return null;
  let accountKey: string | null = null;
  let companyName: string | null = null;
  if (row.company_id) {
    const companies = await database(
      `companies?select=account_key,name&id=eq.${row.company_id}&limit=1`,
    ) as Array<Record<string, string>>;
    accountKey = companies?.[0]?.account_key || null;
    companyName = companies?.[0]?.name || null;
  }
  database(`cal_sessions?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});
  return {
    id: String(row.id),
    role: row.role as Session["role"],
    display_name: String(row.display_name),
    company_id: row.company_id,
    account_key: accountKey,
    company_name: companyName,
  };
}

function accountAllowed(session: Session, accountKey: string) {
  return session.role === "agency" || session.account_key === accountKey;
}

async function companyFor(accountKey: string) {
  const normalized = accountKey.trim().toLowerCase();
  const rows = await database(
    `companies?select=id,account_key,name,features&account_key=eq.${queryValue(normalized)}&limit=1`,
  ) as Array<Record<string, unknown>>;
  return rows?.[0] || null;
}

async function primaryLocation(companyId: string) {
  const rows = await database(
    `company_locations?select=id,google_place_id,name&company_id=eq.${companyId}&is_primary=eq.true&limit=1`,
  ) as Array<Record<string, string | null>>;
  return rows?.[0] || null;
}

async function allAccountKeys() {
  const rows = await database("companies?select=account_key&order=name.asc") as Array<{ account_key: string }>;
  return rows.map((row) => row.account_key);
}

async function pinLogin(req: Request) {
  const body = await bodyJson(req) as { pin?: string };
  const pin = String(body.pin || "").trim();
  if (!/^\d{4,8}$/.test(pin)) return json({ ok: false, error: "Enter a valid PIN" }, 400);

  const ipHash = await sha256(ipAddress(req));
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const failures = await database(
    `pin_attempts?select=id&ip_hash=eq.${ipHash}&successful=eq.false&attempted_at=gte.${queryValue(cutoff)}&limit=6`,
  ) as unknown[];
  if (failures.length >= 5) {
    return json({ ok: false, error: "Too many attempts. Try again in 15 minutes.", remaining: 900 }, 429);
  }

  const pins = await database(
    "access_pins?select=id,company_id,label,role,pin_salt,pin_hash&active=eq.true",
  ) as Array<Record<string, string | null>>;
  let match: Record<string, string | null> | null = null;
  for (const candidate of pins) {
    const candidateHash = await sha256(`${candidate.pin_salt}:${pin}`);
    if (safeEqual(candidateHash, String(candidate.pin_hash))) match = candidate;
  }

  await database("pin_attempts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ip_hash: ipHash, successful: Boolean(match) }),
  });
  if (!match) return json({ ok: false, error: "Invalid PIN" }, 401);

  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await database("cal_sessions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_hash: tokenHash,
      access_pin_id: match.id,
      company_id: match.company_id,
      role: match.role,
      display_name: match.label,
      expires_at: expiresAt,
    }),
  });

  let accounts: string[] = [];
  if (match.role === "agency") accounts = await allAccountKeys();
  else if (match.company_id) {
    const rows = await database(
      `companies?select=account_key&id=eq.${match.company_id}&limit=1`,
    ) as Array<{ account_key: string }>;
    if (rows?.[0]) accounts = [rows[0].account_key];
  }
  return json({
    ok: true,
    token,
    role: match.role === "agency" ? "superadmin" : "admin",
    calRole: match.role === "agency" ? "superadmin" : "client",
    accounts,
    displayName: match.label,
    email: match.role === "agency" ? "admin@cal.marketing" : null,
    expiresAt,
  });
}

async function requireSession(req: Request) {
  const session = await sessionFor(req);
  if (!session) return { response: json({ error: "UNAUTHORIZED" }, 401), session: null };
  return { response: null, session };
}

function reviewId(review: Record<string, unknown>) {
  return String(review.reviewId || review.id || review.name || "");
}

async function normalizeReview(
  companyId: string,
  locationId: string | null,
  source: string,
  review: Record<string, unknown>,
) {
  const reviewer = (review.reviewer || {}) as Record<string, unknown>;
  const reply = (review.reviewReply || review.reply || {}) as Record<string, unknown>;
  const starMap: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const unixTime = typeof review.time === "number" ? new Date(review.time * 1000).toISOString() : null;
  const externalId = reviewId(review) || await sha256([
    review.author_name || reviewer.displayName || "",
    review.time || review.createTime || "",
    review.text || review.comment || "",
  ].join("|"));
  return {
    company_id: companyId,
    location_id: locationId,
    source,
    external_review_id: externalId,
    reviewer_name: review.author_name || reviewer.displayName || null,
    reviewer_photo_url: review.profile_photo_url || reviewer.profilePhotoUrl || null,
    rating: Number(review.rating || starMap[String(review.starRating)] || 0) || null,
    comment: review.text || review.comment || null,
    review_created_at: review.createTime || review.date || unixTime,
    relative_time_description: review.relative_time_description || null,
    reply_comment: typeof review.reply === "string" ? review.reply : reply.comment || null,
    reply_updated_at: reply.updateTime || null,
    raw_payload: review,
    last_seen_at: new Date().toISOString(),
  };
}

async function saveReviews(
  accountKey: string,
  reviews: Array<Record<string, unknown>>,
  meta: Record<string, unknown>,
  source: "google_places" | "google_business_profile",
) {
  const company = await companyFor(accountKey);
  if (!company) throw new Error("Unknown company");
  const location = await primaryLocation(String(company.id));
  const rows = await Promise.all(reviews.map((review) =>
    normalizeReview(String(company.id), location?.id || null, source, review)
  ));
  if (rows.length) {
    await database("reviews?on_conflict=company_id,source,external_review_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  }
  const average = Number(meta.rating ?? meta.averageRating);
  const total = Number(meta.total ?? meta.totalReviewCount);
  if (Number.isFinite(average) || Number.isFinite(total)) {
    await database("review_snapshots", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        company_id: company.id,
        location_id: location?.id || null,
        source,
        average_rating: Number.isFinite(average) ? average : null,
        total_reviews: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0,
      }),
    });
  }
}

async function placesReviews(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("account") || "").trim().toLowerCase();
  if (!account || !accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ error: "Unknown account", reviews: [] }, 404);
  const location = await primaryLocation(String(company.id));
  if (!location?.google_place_id) return json({ error: "Google Place ID is not configured", reviews: [] }, 409);
  if (!GOOGLE_MAPS_API_KEY) return json({ error: "Google Places is not configured", reviews: [] }, 503);

  const googleUrl = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  googleUrl.searchParams.set("place_id", location.google_place_id);
  googleUrl.searchParams.set("fields", "name,rating,user_ratings_total,reviews");
  googleUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);
  const response = await fetch(googleUrl);
  const result = await response.json();
  if (!response.ok || result.status !== "OK") {
    return json({ error: result.error_message || result.status || "Google Places failed", reviews: [] }, 502);
  }
  const place = result.result || {};
  const reviews = place.reviews || [];
  await saveReviews(account, reviews, { rating: place.rating, total: place.user_ratings_total }, "google_places");
  return json({
    name: place.name || company.name,
    rating: place.rating || null,
    total: place.user_ratings_total || 0,
    reviews,
    lowStarAlerts: reviews.filter((review: Record<string, number>) => review.rating <= 2),
  });
}

async function cachedReviews(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("account") || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ reviews: [], total: 0, rating: null });
  const [reviews, snapshots] = await Promise.all([
    database(
      `reviews?select=external_review_id,reviewer_name,reviewer_photo_url,rating,comment,review_created_at,relative_time_description,reply_comment,source&company_id=eq.${company.id}&order=review_created_at.desc&limit=1000`,
    ) as Promise<Array<Record<string, unknown>>>,
    database(
      `review_snapshots?select=average_rating,total_reviews,fetched_at,source&company_id=eq.${company.id}&order=fetched_at.desc&limit=1`,
    ) as Promise<Array<Record<string, unknown>>>,
  ]);
  const latest = snapshots?.[0] || {};
  return json({
    reviews: reviews.map((review) => ({
      id: review.external_review_id,
      author_name: review.reviewer_name,
      profile_photo_url: review.reviewer_photo_url,
      rating: review.rating,
      text: review.comment,
      date: review.review_created_at,
      relative_time_description: review.relative_time_description,
      reply: review.reply_comment,
      source: review.source,
    })),
    total: latest.total_reviews ?? reviews.length,
    rating: latest.average_rating ?? null,
    fetchedAt: latest.fetched_at || null,
  });
}

async function reviewCacheWrite(req: Request) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const body = await bodyJson(req) as Record<string, unknown>;
  const account = String(body.account || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const reviews = Array.isArray(body.reviews) ? body.reviews as Array<Record<string, unknown>> : [];
  await saveReviews(
    account,
    reviews,
    (body.meta || {}) as Record<string, unknown>,
    body.source === "google_places" ? "google_places" : "google_business_profile",
  );
  return json({ ok: true, count: reviews.length });
}

async function homeStats(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("account") || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ error: "Unknown account" }, 404);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [reviews, snapshots, taps] = await Promise.all([
    database(`reviews?select=rating,review_created_at,reply_comment&company_id=eq.${company.id}&limit=5000`) as Promise<Array<Record<string, unknown>>>,
    database(`review_snapshots?select=average_rating,total_reviews&company_id=eq.${company.id}&order=fetched_at.desc&limit=1`) as Promise<Array<Record<string, unknown>>>,
    database(`nfc_taps?select=tapped_at&company_id=eq.${company.id}&order=tapped_at.desc&limit=5000`) as Promise<Array<Record<string, string>>>,
  ]);
  const latest = snapshots?.[0] || {};
  const average = reviews.length
    ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length
    : null;
  return json({
    totalReviews: latest.total_reviews ?? reviews.length,
    avgRating: latest.average_rating ?? (average == null ? null : Math.round(average * 10) / 10),
    weekReviews: reviews.filter((review) => String(review.review_created_at || "") >= weekAgo).length,
    pendingReplies: reviews.filter((review) => !review.reply_comment).length,
    nfcTapsTotal: taps.length,
    nfcTapsWeek: taps.filter((tap) => tap.tapped_at >= weekAgo).length,
  });
}

async function nfcCards(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  if (req.method === "GET") {
    const account = String(url.searchParams.get("account") || auth.session.account_key || "").toLowerCase();
    if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
    const company = await companyFor(account);
    if (!company) return json({ cards: [] });
    const rows = await database(
      `nfc_cards?select=id,card_token,driver_name,label,destination_url,is_active,created_at&company_id=eq.${company.id}&is_active=eq.true&order=created_at.asc`,
    ) as Array<Record<string, unknown>>;
    return json({ cards: rows.map((row) => ({
      id: row.card_token,
      name: row.driver_name || row.label,
      label: row.label,
      destinationUrl: row.destination_url,
      active: row.is_active,
      createdAt: row.created_at,
      tapUrl: `${SUPABASE_URL}/functions/v1/cal-api/tap/${row.card_token}`,
    })) });
  }
  const body = await bodyJson(req) as Record<string, unknown>;
  const account = String(body.account || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ error: "Unknown account" }, 404);
  if (req.method === "POST") {
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "MISSING_NAME" }, 400);
    const cardToken = `card_${randomToken(8)}`;
    const destinationUrl = String(body.destinationUrl || body.reviewUrl || "") || null;
    await database("nfc_cards", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        company_id: company.id,
        card_token: cardToken,
        driver_name: name,
        label: name,
        destination_url: destinationUrl,
        is_active: true,
      }),
    });
    return json({
      ok: true,
      card: { id: cardToken, name, destinationUrl, active: true },
      tapUrl: `${SUPABASE_URL}/functions/v1/cal-api/tap/${cardToken}`,
    });
  }
  if (req.method === "DELETE") {
    const name = String(body.name || "").trim();
    await database(`nfc_cards?company_id=eq.${company.id}&driver_name=eq.${queryValue(name)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
    });
    return json({ ok: true });
  }
  return json({ error: "METHOD_NOT_ALLOWED" }, 405);
}

async function nfcTaps(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("account") || url.searchParams.get("accountId") || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ taps: [], stats: {} });
  const driver = String(url.searchParams.get("cardId") || "");
  const filter = driver ? `&driver_name=eq.${queryValue(driver)}` : "";
  const rows = await database(
    `nfc_taps?select=id,driver_name,tapped_at,metadata&company_id=eq.${company.id}${filter}&order=tapped_at.desc&limit=5000`,
  ) as Array<Record<string, unknown>>;
  const taps = rows.map((row) => ({
    person: row.driver_name,
    tapped_at: row.tapped_at,
    reviewClick: Boolean((row.metadata as Record<string, unknown> || {}).reviewClick),
  }));
  if (driver || routePath(url).endsWith("/stats")) {
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const clicks = taps.filter((tap) => tap.reviewClick).length;
    return json({
      total: taps.length,
      today: taps.filter((tap) => new Date(String(tap.tapped_at)).getTime() >= today.getTime()).length,
      week: taps.filter((tap) => new Date(String(tap.tapped_at)).getTime() >= now - 7 * 86400000).length,
      month: taps.filter((tap) => new Date(String(tap.tapped_at)).getTime() >= now - 30 * 86400000).length,
      clicks,
      conversion: taps.length ? Math.round(clicks / taps.length * 100) : 0,
      lastTap: taps[0]?.tapped_at || null,
      taps,
    });
  }
  return json({ taps, stats: {} });
}

async function driverStats(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("account") || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ drivers: [], period: url.searchParams.get("period") || "month" });
  const [cards, taps] = await Promise.all([
    database(`nfc_cards?select=driver_name&company_id=eq.${company.id}&is_active=eq.true`) as Promise<Array<{ driver_name: string }>>,
    database(`nfc_taps?select=driver_name,tapped_at&company_id=eq.${company.id}&order=tapped_at.desc&limit=5000`) as Promise<Array<{ driver_name: string; tapped_at: string }>>,
  ]);
  const now = Date.now();
  const drivers = cards.map((card) => {
    const own = taps.filter((tap) => tap.driver_name === card.driver_name);
    return {
      name: card.driver_name,
      lastTap: own[0]?.tapped_at || null,
      taps: {
        today: own.filter((tap) => new Date(tap.tapped_at).toDateString() === new Date().toDateString()).length,
        week: own.filter((tap) => new Date(tap.tapped_at).getTime() >= now - 7 * 86400000).length,
        month: own.filter((tap) => new Date(tap.tapped_at).getTime() >= now - 30 * 86400000).length,
        alltime: own.length,
      },
    };
  });
  const period = url.searchParams.get("period") || "month";
  const key = period === "week" ? "week" : period === "alltime" ? "alltime" : "month";
  drivers.sort((left, right) => right.taps[key] - left.taps[key]);
  return json({ drivers, period });
}

async function tapRedirect(req: Request, route: string) {
  const identifier = decodeURIComponent(route.split("/").pop() || "");
  const byToken = route.startsWith("/tap/");
  const filter = byToken
    ? `card_token=eq.${queryValue(identifier)}`
    : `driver_name=eq.${queryValue(identifier)}`;
  const cards = await database(
    `nfc_cards?select=id,company_id,driver_name,destination_url&${filter}&is_active=eq.true&limit=1`,
  ) as Array<Record<string, string | null>>;
  const card = cards?.[0];
  if (!card) return json({ error: "NFC card not found" }, 404);
  await database("nfc_taps", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      company_id: card.company_id,
      card_id: card.id,
      driver_name: card.driver_name,
      referrer: req.headers.get("referer"),
      user_agent: req.headers.get("user-agent"),
      metadata: { ipHash: await sha256(ipAddress(req)), reviewClick: true },
    }),
  });
  let destination = card.destination_url;
  if (!destination) {
    const location = await primaryLocation(String(card.company_id));
    if (location?.google_place_id) {
      destination = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(location.google_place_id)}`;
    }
  }
  if (!destination) return json({ error: "Review destination is not configured" }, 409);
  return new Response(null, { status: 302, headers: { ...cors, Location: destination } });
}

async function metadata(req: Request, url: URL) {
  const auth = await requireSession(req);
  if (!auth.session) return auth.response!;
  const account = String(url.searchParams.get("key") || auth.session.account_key || "").toLowerCase();
  if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
  const company = await companyFor(account);
  if (!company) return json({ meta: null });
  if (req.method === "GET") {
    const rows = await database(`account_metadata?select=data&company_id=eq.${company.id}&limit=1`) as Array<{ data: unknown }>;
    return json({ meta: rows?.[0]?.data || null });
  }
  if (req.method === "PUT") {
    const data = await bodyJson(req);
    await database("account_metadata?on_conflict=company_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ company_id: company.id, data, updated_at: new Date().toISOString() }),
    });
    return json({ ok: true });
  }
  return json({ error: "METHOD_NOT_ALLOWED" }, 405);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Supabase function environment is incomplete" }, 500);
  const url = new URL(req.url);
  const route = routePath(url);
  try {
    if (route === "/" || route === "/health" || route === "/api/supabase/health") {
      const companies = await database("companies?select=id&limit=1");
      return json({ connected: Array.isArray(companies), service: "cal-api" });
    }
    if (route === "/api/agency-pin" && req.method === "POST") return await pinLogin(req);
    if (route === "/api/auth/login" || route === "/api/meta/login") {
      return json({ error: "Use your company PIN" }, 400);
    }
    if (route === "/api/auth/user" && req.method === "GET") {
      const auth = await requireSession(req);
      if (!auth.session) return auth.response!;
      return json({
        email: auth.session.role === "agency" ? "admin@cal.marketing" : null,
        role: auth.session.role === "agency" ? "superadmin" : "admin",
        calRole: auth.session.role === "agency" ? "superadmin" : "client",
        accounts: auth.session.role === "agency" ? await allAccountKeys() : [auth.session.account_key],
        displayName: auth.session.display_name,
      });
    }
    if (route === "/api/config") return json({ mapsKey: "" });
    if (route === "/api/account/config") {
      const auth = await requireSession(req);
      if (!auth.session) return auth.response!;
      const account = String(url.searchParams.get("account") || auth.session.account_key || "").toLowerCase();
      if (!accountAllowed(auth.session, account)) return json({ error: "FORBIDDEN" }, 403);
      const company = await companyFor(account);
      if (!company) return json({});
      const location = await primaryLocation(String(company.id));
      return json({ ...(company.features as Record<string, unknown> || {}), placeId: location?.google_place_id || null });
    }
    if (route === "/api/reviews/places" && req.method === "GET") return await placesReviews(req, url);
    if (route === "/api/reviews" && req.method === "GET") return await cachedReviews(req, url);
    if (route === "/api/reviews/cache" && req.method === "POST") return await reviewCacheWrite(req);
    if (route === "/api/home/stats" && req.method === "GET") return await homeStats(req, url);
    if (route === "/api/nfc/cards") return await nfcCards(req, url);
    if (route === "/api/nfc/taps" && req.method === "GET") return await nfcTaps(req, url);
    if (route === "/api/nfc/stats" && req.method === "GET") return await nfcTaps(req, url);
    if (route === "/api/drivers/stats" && req.method === "GET") return await driverStats(req, url);
    if (route === "/api/meta") return await metadata(req, url);
    if ((route.startsWith("/tap/") || route.startsWith("/d/")) && req.method === "GET") {
      return await tapRedirect(req, route);
    }
    if (route.startsWith("/api/google/") || route.startsWith("/api/gbp/") ||
        route.startsWith("/api/drive/") || route.startsWith("/api/stripe/") ||
        route.startsWith("/api/calendar/") || route.startsWith("/api/gsc/")) {
      return json({ connected: false, configured: false, error: "Integration is not configured in Supabase yet" }, 503);
    }
    return json({ error: "NOT_FOUND", route }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
  }
});
