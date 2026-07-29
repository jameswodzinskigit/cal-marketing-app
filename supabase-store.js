'use strict';

const crypto = require('crypto');

class SupabaseStore {
  constructor(options = {}) {
    this.url = String(options.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    this.serviceKey = options.serviceKey || process.env.SUPABASE_SERVICE_KEY || '';
    this.fetch = options.fetch || global.fetch;
  }

  get configured() {
    return Boolean(this.url && this.serviceKey && this.fetch);
  }

  async request(path, options = {}) {
    if (!this.configured) throw new Error('Supabase is not configured');
    const headers = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const response = await this.fetch(`${this.url}/rest/v1/${path}`, { ...options, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = text; }
    }
    if (!response.ok) {
      const detail = body && (body.message || body.hint || body.details);
      throw new Error(`Supabase ${response.status}: ${detail || text || 'request failed'}`);
    }
    return body;
  }

  async health() {
    if (!this.configured) return { connected: false, reason: 'SUPABASE_URL or SUPABASE_SERVICE_KEY missing' };
    try {
      const rows = await this.request('companies?select=id&limit=1');
      return { connected: Array.isArray(rows), projectRef: new URL(this.url).hostname.split('.')[0] };
    } catch (error) {
      return { connected: false, reason: error.message };
    }
  }

  async getCompany(accountKey) {
    const key = String(accountKey || '').trim().toLowerCase();
    if (!key) return null;
    const rows = await this.request(`companies?select=id,account_key,name,features&account_key=eq.${encodeURIComponent(key)}&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async getPrimaryLocation(companyId) {
    if (!companyId) return null;
    const rows = await this.request(`company_locations?select=id,google_place_id,name&company_id=eq.${encodeURIComponent(companyId)}&is_primary=eq.true&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  reviewExternalId(review) {
    const explicit = review.reviewId || review.review_id || review.id || review.name;
    if (explicit) return String(explicit);
    const stable = [
      review.author_name || review.reviewer?.displayName || review.reviewer_name || '',
      review.time || review.createTime || review.review_created_at || '',
      review.text || review.comment || '',
    ].join('|');
    return crypto.createHash('sha256').update(stable).digest('hex');
  }

  normalizeReview(companyId, locationId, source, review) {
    const unixTime = typeof review.time === 'number' ? new Date(review.time * 1000).toISOString() : null;
    const starRating = typeof review.starRating === 'string'
      ? { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[review.starRating]
      : null;
    const reply = review.reviewReply || review.reply || null;
    return {
      company_id: companyId,
      location_id: locationId || null,
      source,
      external_review_id: this.reviewExternalId(review),
      reviewer_name: review.author_name || review.reviewer?.displayName || review.reviewer_name || null,
      reviewer_photo_url: review.profile_photo_url || review.reviewer?.profilePhotoUrl || null,
      rating: Number(review.rating || starRating || 0) || null,
      comment: review.text || review.comment || null,
      review_created_at: review.createTime || review.date || unixTime,
      relative_time_description: review.relative_time_description || null,
      reply_comment: typeof reply === 'string' ? reply : reply?.comment || null,
      reply_updated_at: reply?.updateTime || null,
      raw_payload: review,
      last_seen_at: new Date().toISOString(),
    };
  }

  async saveReviews(accountKey, reviews, meta = {}, source = 'google_places') {
    const company = await this.getCompany(accountKey);
    if (!company) throw new Error(`Unknown Supabase company: ${accountKey}`);
    const location = await this.getPrimaryLocation(company.id);
    const normalized = (Array.isArray(reviews) ? reviews : [])
      .map(review => this.normalizeReview(company.id, location?.id, source, review));

    if (normalized.length) {
      await this.request('reviews?on_conflict=company_id,source,external_review_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(normalized),
      });
    }

    const averageRating = Number(meta.rating ?? meta.averageRating);
    const totalReviews = Number(meta.total ?? meta.totalReviewCount);
    if (Number.isFinite(averageRating) || Number.isFinite(totalReviews)) {
      await this.request('review_snapshots', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          company_id: company.id,
          location_id: location?.id || null,
          source,
          average_rating: Number.isFinite(averageRating) ? averageRating : null,
          total_reviews: Number.isFinite(totalReviews) ? Math.max(0, Math.trunc(totalReviews)) : 0,
        }),
      });
    }

    return { count: normalized.length, companyId: company.id, locationId: location?.id || null };
  }

  async getReviews(accountKey, limit = 1000) {
    const company = await this.getCompany(accountKey);
    if (!company) return [];
    const rows = await this.request(
      `reviews?select=external_review_id,reviewer_name,reviewer_photo_url,rating,comment,review_created_at,relative_time_description,reply_comment,reply_updated_at,source&company_id=eq.${company.id}&order=review_created_at.desc&limit=${Math.min(limit, 5000)}`
    );
    return (Array.isArray(rows) ? rows : []).map(row => ({
      id: row.external_review_id,
      author_name: row.reviewer_name,
      profile_photo_url: row.reviewer_photo_url,
      rating: row.rating,
      text: row.comment,
      date: row.review_created_at,
      relative_time_description: row.relative_time_description,
      reply: row.reply_comment,
      replyUpdatedAt: row.reply_updated_at,
      source: row.source,
    }));
  }

  async getLatestReviewSnapshot(accountKey) {
    const company = await this.getCompany(accountKey);
    if (!company) return null;
    const rows = await this.request(
      `review_snapshots?select=average_rating,total_reviews,fetched_at,source&company_id=eq.${company.id}&order=fetched_at.desc&limit=1`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async getNfcCards(accountKey) {
    const company = await this.getCompany(accountKey);
    if (!company) return [];
    const rows = await this.request(
      `nfc_cards?select=id,card_token,driver_name,label,destination_url,is_active,created_at&company_id=eq.${company.id}&order=created_at.asc`
    );
    return (Array.isArray(rows) ? rows : []).map(row => ({
      id: row.card_token,
      databaseId: row.id,
      name: row.driver_name || row.label,
      label: row.label,
      destinationUrl: row.destination_url,
      active: row.is_active,
      createdAt: row.created_at,
    }));
  }

  async saveNfcCard(accountKey, card) {
    const company = await this.getCompany(accountKey);
    if (!company) throw new Error(`Unknown Supabase company: ${accountKey}`);
    const payload = {
      company_id: company.id,
      card_token: card.id,
      driver_name: card.name || null,
      label: card.label || card.name || null,
      destination_url: card.destinationUrl || null,
      is_active: card.active !== false,
    };
    await this.request('nfc_cards?on_conflict=card_token', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });
    return card;
  }

  async disableNfcCard(accountKey, driverName) {
    const company = await this.getCompany(accountKey);
    if (!company) return;
    await this.request(
      `nfc_cards?company_id=eq.${company.id}&driver_name=eq.${encodeURIComponent(driverName)}`,
      { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: false }) }
    );
  }

  async saveNfcTap(accountKey, driverName, metadata = {}) {
    const company = await this.getCompany(accountKey);
    if (!company) throw new Error(`Unknown Supabase company: ${accountKey}`);
    const cards = await this.request(
      `nfc_cards?select=id&company_id=eq.${company.id}&driver_name=eq.${encodeURIComponent(driverName)}&is_active=eq.true&limit=1`
    );
    await this.request('nfc_taps', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        company_id: company.id,
        card_id: cards?.[0]?.id || null,
        driver_name: driverName || null,
        referrer: metadata.referrer || null,
        user_agent: metadata.userAgent || null,
        metadata: { ip: metadata.ip || null, reviewClick: Boolean(metadata.reviewClick) },
      }),
    });
  }

  async getNfcTaps(accountKey, driverName, limit = 5000) {
    const company = await this.getCompany(accountKey);
    if (!company) return [];
    const driverFilter = driverName ? `&driver_name=eq.${encodeURIComponent(driverName)}` : '';
    const rows = await this.request(
      `nfc_taps?select=id,driver_name,tapped_at,referrer,user_agent,metadata&company_id=eq.${company.id}${driverFilter}&order=tapped_at.desc&limit=${Math.min(limit, 5000)}`
    );
    return (Array.isArray(rows) ? rows : []).map(row => ({
      id: row.id,
      person: row.driver_name,
      tapped_at: row.tapped_at,
      referrer: row.referrer,
      userAgent: row.user_agent,
      ip: row.metadata?.ip || '',
      reviewClick: Boolean(row.metadata?.reviewClick),
    }));
  }
}

module.exports = { SupabaseStore };
