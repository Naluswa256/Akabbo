/**
 * k6 load test — Akabbo AI chat concurrent users
 *
 * Tests the real /events/:id/assistant endpoint with actual tool-calling
 * AI turns against staging. NOT a health-check ping — this exercises the
 * full Gemini → RLS transaction → DB connection path.
 *
 * Stages:
 *   Ramp up:   0 → 10 VUs over 30s  (warm-up, confirm baseline works)
 *   Hold:      10 VUs for 60s        (measure steady-state)
 *   Spike:     10 → 30 VUs over 20s  (find where things start degrading)
 *   Hold:      30 VUs for 60s        (measure under load)
 *   Ramp down: 30 → 0 VUs over 20s   (cool-down)
 *
 * Run:
 *   k6 run test/load/chat-load-test.js
 *
 * Watch simultaneously:
 *   Cloud SQL  → connections_used metric in Cloud Monitoring
 *   Cloud Run  → request_latencies + instance_count in Cloud Monitoring
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL  = 'https://akabbo-api-gzjbhqxx3q-ew.a.run.app';
const EVENT_ID  = '210d2484-2ce7-4160-bfe7-7895af763ce2';

// Real JWT from staging (expires in 1h from issue time).
// Override at runtime: k6 run --env ACCESS_TOKEN=<new_token> chat-load-test.js
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5ODc2NzlkNy0wYjVjLTQxYzItYWNkNC02NTdhYWQ3YTE5ZmMiLCJwdiI6dHJ1ZSwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc4NTQwNzYxNiwiZXhwIjoxNzg1NDExMjE2fQ.OlVZNDzEjKZlTzGAf9FyzMSOAB5A2gqAYS5BkwQZd9w';

// Realistic read-only AI prompts — each triggers real tool calls (get_event_overview,
// get_budget, find_contributor etc.) which stresses the DB connection pool.
// No write operations — test is repeatable without polluting staging data.
const PROMPTS = [
  'How much have we collected so far?',
  'What is our current budget breakdown?',
  'Give me an overview of the event.',
  'How many people have paid?',
  'What is still outstanding?',
  'How are we doing against the target?',
  'Summarise the event progress for me.',
  'What percentage of contributors have fully paid?',
];

// ── Custom metrics ─────────────────────────────────────────────────────────────
const chatDuration  = new Trend('chat_turn_duration_ms', true);
const chatErrors    = new Counter('chat_errors_total');
const rateLimitHits = new Counter('gemini_rate_limit_hits');
const successRate   = new Rate('chat_success_rate');

// ── Load shape ─────────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '30s', target: 10 },  // ramp up — warm up Cloud Run + DB pool
    { duration: '60s', target: 10 },  // hold at 10 VUs — baseline measurement
    { duration: '20s', target: 30 },  // spike to 30 VUs — find degradation point
    { duration: '60s', target: 30 },  // hold at 30 VUs — measure under load
    { duration: '20s', target: 0  },  // cool down
  ],
  thresholds: {
    // p95 chat turn must complete within 30s
    // (Gemini turns with tool calls are slow — 5–15s is normal; 30s is failure)
    'chat_turn_duration_ms': ['p(95)<30000'],
    // At least 80% of turns must succeed
    // (graceful rate-limit replies still return HTTP 200, not counted as failures)
    'chat_success_rate': ['rate>0.80'],
    // HTTP-level error rate (5xx, timeouts) must stay below 10%
    'http_req_failed': ['rate<0.10'],
  },
};

// ── Main VU function (runs once per VU per iteration) ─────────────────────────
export default function () {
  const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];

  const res = http.post(
    `${BASE_URL}/events/${EVENT_ID}/assistant`,
    JSON.stringify({ message: prompt }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
      timeout: '35s',
      tags: { endpoint: 'assistant_chat' },
    },
  );

  chatDuration.add(res.timings.duration);

  const ok = check(res, {
    'HTTP 200':        (r) => r.status === 200 || r.status === 201,
    'has reply field': (r) => {
      try { return Boolean(JSON.parse(r.body).reply); } catch { return false; }
    },
  });

  successRate.add(ok);

  if (!ok) {
    chatErrors.add(1);
    console.error(`[VU ${__VU}] FAILED status=${res.status} body=${String(res.body).slice(0, 200)}`);
  }

  // Detect graceful rate-limit replies (HTTP 200 but "high demand" message —
  // added in our gemini-llm.provider.ts change)
  try {
    const body = JSON.parse(res.body);
    if (body.reply && body.reply.includes('high demand')) {
      rateLimitHits.add(1);
      console.warn(`[VU ${__VU}] Gemini rate-limited (graceful) — ${res.timings.duration.toFixed(0)}ms`);
    }
  } catch { /* non-JSON body already counted as error above */ }

  // Real users pause 2–8s between sends (reading the reply, typing next message)
  sleep(2 + Math.random() * 6);
}

// ── End-of-test summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;
  const p = (metric, stat) => (m[metric]?.values?.[stat] ?? 0).toFixed(0);
  const r = {
    testRun:       new Date().toISOString(),
    eventId:       EVENT_ID,
    totalRequests: m.http_reqs?.values?.count ?? 0,
    failedHttp:    m.http_req_failed?.values?.passes ?? 0,
    chatErrors:    m.chat_errors_total?.values?.count ?? 0,
    rateLimits:    m.gemini_rate_limit_hits?.values?.count ?? 0,
    successPct:    ((m.chat_success_rate?.values?.rate ?? 0) * 100).toFixed(1) + '%',
    p50_ms:        p('chat_turn_duration_ms', 'p(50)'),
    p90_ms:        p('chat_turn_duration_ms', 'p(90)'),
    p95_ms:        p('chat_turn_duration_ms', 'p(95)'),
    max_ms:        p('chat_turn_duration_ms', 'max'),
  };

  const pad = (s, n) => String(s).padEnd(n);

  return {
    'test/load/results-latest.json': JSON.stringify(r, null, 2),
    stdout: `
╔════════════════════════════════════════════════════╗
║      Akabbo AI Chat Load Test — Results            ║
╠════════════════════════════════════════════════════╣
║ Total requests  : ${pad(r.totalRequests, 31)}║
║ Failed (HTTP)   : ${pad(r.failedHttp, 31)}║
║ Chat errors     : ${pad(r.chatErrors, 31)}║
║ Rate-limit hits : ${pad(r.rateLimits, 31)}║
║ Success rate    : ${pad(r.successPct, 31)}║
╠════════════════════════════════════════════════════╣
║ Latency p50     : ${pad(r.p50_ms + 'ms', 31)}║
║ Latency p90     : ${pad(r.p90_ms + 'ms', 31)}║
║ Latency p95     : ${pad(r.p95_ms + 'ms', 31)}║
║ Latency max     : ${pad(r.max_ms + 'ms', 31)}║
╚════════════════════════════════════════════════════╝
`,
  };
}
