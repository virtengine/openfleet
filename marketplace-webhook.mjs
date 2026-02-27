/**
 * marketplace-webhook.mjs — GitHub Marketplace purchase event handler
 *
 * WHO USES THIS: VirtEngine (publisher), NOT end users.
 *
 * Handles the GitHub Marketplace listing webhook — fires ONLY on plan
 * purchases, upgrades, and cancellations. Used for billing and analytics.
 *
 * To configure:
 *   1. Go to your Marketplace listing draft → "Webhook" in left sidebar
 *   2. Payload URL: https://webhooks.bosun.virtengine.com/marketplace
 *   3. Content type: application/json
 *   4. Secret: value of BOSUN_MARKETPLACE_WEBHOOK_SECRET
 *   5. Check "Active"
 *
 * ## What marketplace_purchase events look like
 *
 * GitHub sends a `marketplace_purchase` event with one of these actions:
 *   - "purchased"               — new customer bought a plan
 *   - "changed"                 — customer upgraded or downgraded
 *   - "cancelled"               — customer cancelled their plan
 *   - "pending_change"          — plan change staged (billing cycle end)
 *   - "pending_change_cancelled"— pending change was cancelled
 *
 * Payload shape:
 * {
 *   action: "purchased",
 *   effective_date: "2026-02-24T00:00:00+00:00",
 *   sender: { login: "octocat", id: 1 },
 *   marketplace_purchase: {
 *     account: { type: "User"|"Organization", id: 123, login: "octocat" },
 *     billing_cycle: "monthly"|"yearly",
 *     unit_count: 1,
 *     on_free_trial: false,
 *     free_trial_ends_on: null,
 *     next_billing_date: "2026-03-01",
 *     plan: {
 *       id: 1234,
 *       name: "Pro",
 *       description: "Pro plan",
 *       monthly_price_in_cents: 999,
 *       yearly_price_in_cents: 9990,
 *       price_model: "flat-rate"|"per-unit"|"free",
 *       unit_name: null,
 *       bullets: ["Feature A", "Feature B"]
 *     },
 *     previous_marketplace_purchase: { ... } // only on "changed" action
 *   }
 * }
 *
 * @module marketplace-webhook
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verifies the X-Hub-Signature-256 on a marketplace webhook delivery.
 * Uses BOSUN_MARKETPLACE_WEBHOOK_SECRET (separate from the App webhook secret).
 *
 * @param {Buffer|string} rawBody
 * @param {string} sigHeader — value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
export function verifyMarketplaceSignature(rawBody, sigHeader) {
  const secret = process.env.BOSUN_MARKETPLACE_WEBHOOK_SECRET || "";
  if (!secret) {
    console.warn("[marketplace-webhook] BOSUN_MARKETPLACE_WEBHOOK_SECRET is not set — rejecting all events");
    return false;
  }
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;

  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const provided = Buffer.from(sigHeader);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ── Event emitter ─────────────────────────────────────────────────────────────

/**
 * EventEmitter that broadcasts parsed marketplace_purchase events.
 *
 * Events emitted:
 *   marketplace:purchased            — new customer
 *   marketplace:changed              — plan upgrade/downgrade
 *   marketplace:cancelled            — cancellation
 *   marketplace:pending_change       — staged change
 *   marketplace:pending_change_cancelled
 *   marketplace:error                — signature failure or parse error
 *
 * @type {EventEmitter}
 */
export const marketplaceEvents = new EventEmitter();

// ── Plan data helpers ─────────────────────────────────────────────────────────

/**
 * Returns a normalised summary of a marketplace_purchase payload.
 *
 * @param {object} payload
 * @returns {{
 *   action: string,
 *   account: string,
 *   accountType: string,
 *   accountId: number,
 *   plan: string,
 *   planId: number,
 *   billingCycle: string,
 *   priceMonthly: number,
 *   effectiveDate: string,
 *   onFreeTrial: boolean,
 *   previousPlan: string|null
 * }}
 */
export function summarisePurchaseEvent(payload) {
  const mp = payload?.marketplace_purchase ?? {};
  const plan = mp.plan ?? {};
  const prev = mp.previous_marketplace_purchase?.plan ?? null;
  return {
    action:         payload?.action ?? "unknown",
    account:        mp.account?.login ?? "unknown",
    accountType:    mp.account?.type ?? "User",
    accountId:      mp.account?.id ?? 0,
    plan:           plan.name ?? "unknown",
    planId:         plan.id ?? 0,
    billingCycle:   mp.billing_cycle ?? "monthly",
    priceMonthly:   plan.monthly_price_in_cents ?? 0,
    effectiveDate:  payload?.effective_date ?? "",
    onFreeTrial:    Boolean(mp.on_free_trial),
    previousPlan:   prev?.name ?? null,
  };
}

// ── Request handler (framework-agnostic) ─────────────────────────────────────

/**
 * Handles an incoming marketplace webhook POST request.
 *
 * Framework-agnostic: accepts raw body + headers, returns { status, body }.
 * Integrate into your Express/Fastify/Node http server as needed.
 *
 * @param {Buffer|string} rawBody
 * @param {Record<string,string>} headers
 * @returns {{ status: number, body: object }}
 */
export function handleMarketplaceWebhook(rawBody, headers) {
  const sig = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"] ?? "";

  if (!verifyMarketplaceSignature(rawBody, sig)) {
    marketplaceEvents.emit("marketplace:error", { reason: "invalid_signature" });
    return { status: 401, body: { ok: false, error: "Invalid signature" } };
  }

  let payload;
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch (err) {
    return { status: 400, body: { ok: false, error: "Invalid JSON" } };
  }

  const event = headers["x-github-event"] ?? headers["X-GitHub-Event"] ?? "unknown";

  if (event !== "marketplace_purchase") {
    // Not a marketplace event — acknowledge but don't process
    return { status: 200, body: { ok: true, ignored: true, event } };
  }

  const summary = summarisePurchaseEvent(payload);
  const action = payload?.action ?? "unknown";
  const eventName = `marketplace:${action}`;

  console.log(`[marketplace-webhook] ${eventName}: ${summary.account} → plan "${summary.plan}" (${summary.billingCycle})`);

  marketplaceEvents.emit(eventName, { summary, payload });
  marketplaceEvents.emit("marketplace:any", { action, summary, payload });

  // Developer hook: log plan change details
  if (action === "changed" && summary.previousPlan) {
    console.log(`[marketplace-webhook]   ↳ plan change: "${summary.previousPlan}" → "${summary.plan}"`);
  }
  if (action === "cancelled") {
    console.log(`[marketplace-webhook]   ↳ cancellation effective: ${summary.effectiveDate}`);
  }

  return { status: 200, body: { ok: true, action, account: summary.account, plan: summary.plan } };
}

// ── Standalone Node http handler (for local testing) ─────────────────────────

/**
 * Creates a simple Node.js http request handler for the marketplace webhook.
 * Mount this at POST /webhook/marketplace when testing locally.
 *
 * Example (local test only — production uses VirtEngine's relay server):
 *   import { createServer } from 'node:http'
 *   import { createMarketplaceRequestHandler } from 'bosun/marketplace-webhook'
 *   createServer(createMarketplaceRequestHandler()).listen(54320)
 *
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createMarketplaceRequestHandler() {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Read raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Normalise headers to lowercase keys
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }

    const { status, body } = handleMarketplaceWebhook(rawBody, headers);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}
