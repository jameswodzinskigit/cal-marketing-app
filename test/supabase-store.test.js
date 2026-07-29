'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseStore } = require('../supabase-store');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body == null ? '' : JSON.stringify(body),
  };
}

test('health reports the configured project', async () => {
  const calls = [];
  const store = new SupabaseStore({
    url: 'https://project-ref.supabase.co',
    serviceKey: 'server-only-key',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response([{ id: 'company-id' }]);
    },
  });

  assert.deepEqual(await store.health(), { connected: true, projectRef: 'project-ref' });
  assert.equal(calls[0].options.headers.apikey, 'server-only-key');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer server-only-key');
});

test('saveReviews upserts reviews and writes a rating snapshot', async () => {
  const calls = [];
  const store = new SupabaseStore({
    url: 'https://project-ref.supabase.co',
    serviceKey: 'server-only-key',
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/companies?')) return response([{ id: 'company-id', account_key: 'greencollar' }]);
      if (url.includes('/company_locations?')) return response([{ id: 'location-id', google_place_id: 'place-id' }]);
      return response(null, 201);
    },
  });

  const result = await store.saveReviews('greencollar', [{
    author_name: 'Customer',
    rating: 5,
    text: 'Great work',
    time: 1700000000,
  }], { rating: 4.9, total: 125 }, 'google_places');

  assert.equal(result.count, 1);
  const reviewCall = calls.find(call => call.url.includes('/reviews?on_conflict='));
  const review = JSON.parse(reviewCall.options.body)[0];
  assert.equal(review.company_id, 'company-id');
  assert.equal(review.location_id, 'location-id');
  assert.equal(review.rating, 5);
  assert.equal(review.source, 'google_places');
  assert.match(review.external_review_id, /^[a-f0-9]{64}$/);

  const snapshotCall = calls.find(call => call.url.endsWith('/review_snapshots'));
  assert.deepEqual(JSON.parse(snapshotCall.options.body), {
    company_id: 'company-id',
    location_id: 'location-id',
    source: 'google_places',
    average_rating: 4.9,
    total_reviews: 125,
  });
});

test('service errors are surfaced without leaking the key', async () => {
  const store = new SupabaseStore({
    url: 'https://project-ref.supabase.co',
    serviceKey: 'do-not-leak-this',
    fetch: async () => response({ message: 'permission denied' }, 403),
  });

  await assert.rejects(() => store.getCompany('greencollar'), error => {
    assert.match(error.message, /Supabase 403: permission denied/);
    assert.doesNotMatch(error.message, /do-not-leak-this/);
    return true;
  });
});
