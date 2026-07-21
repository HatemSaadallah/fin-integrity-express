import type { FinIntegrityClient, EventType, SubscriptionInput } from "@fin-integrity/node";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal structural types so we don't depend on @types/express.
interface ReqLike {
  body: any;
  headers: Record<string, any>;
}
interface ResLike {
  status(code: number): ResLike;
  json(body: any): void;
  send(body: any): void;
  on(event: string, cb: () => void): void;
}
type Next = (err?: unknown) => void;

/**
 * Stripe's dispute statuses -> the statuses the ingest service accepts
 * (needs_response | under_review | won | lost). Stripe's `warning_*` variants are
 * the same states during the early-fraud-warning phase, so they fold onto their
 * base status. Anything absent from this map is deliberately NOT recorded:
 *   - `warning_closed`   — an early warning that never became a dispute (no money moved)
 *   - `charge_refunded`  — the charge was refunded, which arrives as its own refund
 *                          event; recording it as a dispute too would double-count.
 * Sending an unmapped value instead would just be rejected by the server.
 */
const DISPUTE_STATUS: Record<string, string> = {
  warning_needs_response: "needs_response",
  warning_under_review: "under_review",
  needs_response: "needs_response",
  under_review: "under_review",
  won: "won",
  lost: "lost",
};

/**
 * Stripe's payment statuses -> financial_event_status.
 *
 * Stripe has a different status vocabulary per object and it is wider than ours,
 * so a raw pass-through sends values the server's enum rejects — and a rejected
 * charge is a charge reconciliation never sees, which it then reports as a
 * discrepancy that doesn't exist. Everything not yet settled folds onto
 * `pending`: it is money that has not moved, which is exactly what the engine
 * needs to know. Unmapped values are skipped rather than guessed at.
 */
const PAYMENT_STATUS: Record<string, string> = {
  succeeded: "succeeded",
  pending: "pending",
  processing: "pending",
  requires_payment_method: "pending",
  requires_confirmation: "pending",
  requires_action: "pending",
  requires_capture: "pending",
  failed: "failed",
  canceled: "canceled",
};

/** Refunds carry their own smaller vocabulary. */
const REFUND_STATUS: Record<string, string> = {
  succeeded: "succeeded",
  pending: "pending",
  requires_action: "pending",
  failed: "failed",
  canceled: "canceled",
};

/**
 * Stripe's subscription statuses -> the five the SDK accepts. `unpaid` folds onto
 * `past_due` (both mean billing is failing and the charge hasn't landed).
 * `incomplete` / `incomplete_expired` are absent on purpose: those subscriptions
 * never activated, so no charge is expected for them and recording one as `active`
 * would manufacture a missing-charge incident.
 */
const SUBSCRIPTION_STATUS: Record<string, SubscriptionInput["status"]> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  paused: "paused",
};

const INTERVALS = new Set(["day", "week", "month", "year"]);

/**
 * Express handler that verifies an incoming Stripe webhook and captures its
 * payment/refund/dispute/subscription events. Mount with the raw body parser so signature
 * verification works: `app.post("/webhooks/stripe", express.raw({ type: "application/json" }), handler)`.
 */
export function stripeWebhookHandler(
  fi: FinIntegrityClient,
  opts: {
    stripe: any;
    secret: string;
    /**
     * Environment to tag captured events with. A string pins one; a function
     * receives the verified Stripe event and returns a name. Omit to use the
     * default — Stripe's own `livemode`, so test webhooks land in `test` and
     * live ones in `production`, never reconciling against each other. Pass your
     * own names (e.g. `e => (e.livemode ? "prod" : "sandbox")`) to override.
     */
    environment?: string | ((event: any) => string | undefined);
  },
) {
  return (req: ReqLike, res: ResLike): void => {
    let event: any;
    try {
      event = opts.stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], opts.secret);
    } catch (err) {
      res.status(400).send(`Webhook signature verification failed: ${(err as Error).message}`);
      return;
    }
    try {
      captureStripeWebhook(fi, event, resolveEnvironment(opts.environment, event));
    } catch {
      /* fail-open — never break the webhook ack */
    }
    res.json({ received: true });
  };
}

/** Live vs test Stripe traffic is genuinely different money, so keep it in
 *  separate environments by default; a caller can override with their own names. */
function resolveEnvironment(
  env: string | ((event: any) => string | undefined) | undefined,
  event: any,
): string | undefined {
  if (typeof env === "function") return env(event);
  if (typeof env === "string") return env;
  return event?.livemode === false ? "test" : "production";
}

/** Middleware that flushes queued events after each response finishes. */
export function flushOnResponse(fi: FinIntegrityClient) {
  return (_req: ReqLike, res: ResLike, next: Next): void => {
    res.on("finish", () => void fi.flush());
    next();
  };
}

function captureStripeWebhook(fi: FinIntegrityClient, event: any, environment?: string): void {
  const obj = event?.data?.object;
  if (!obj || typeof obj !== "object") return;
  const kind: string = obj.object;

  if (kind === "subscription") return captureSubscription(fi, event, obj, environment);
  if (kind === "invoice") return captureInvoice(fi, event, obj, environment);

  let type: EventType;
  if (kind === "refund") type = "refund";
  else if (kind === "dispute") type = "dispute";
  else if (kind === "charge" || kind === "payment_intent") type = "payment";
  else return;

  let status: string | undefined;
  if (type === "dispute") {
    status = DISPUTE_STATUS[String(obj.status)];
    if (!status) return; // unmappable — skip rather than send a status ingest rejects
  } else if (obj.status) {
    status = (type === "refund" ? REFUND_STATUS : PAYMENT_STATUS)[String(obj.status)];
    if (!status) return; // same rule: never forward a status the enum will reject
  }

  // A dispute acts on a charge; link it so reconciliation can net it against the payment.
  const parent = type === "dispute" ? obj.charge ?? obj.payment_intent : undefined;
  const amount = type === "payment" ? obj.amount_received ?? obj.amount : obj.amount;
  const reference =
    obj.metadata?.reference ??
    obj.metadata?.order_id ??
    (type === "refund" ? obj.charge ?? obj.payment_intent ?? obj.id : parent ?? obj.id);

  fi.capture({
    side: "processor",
    type,
    source: "stripe",
    reference: String(reference),
    external_id: String(obj.id),
    // Forwarded raw on purpose: if Stripe sends something that isn't an integer
    // minor-unit amount, the core SDK's amount invariant rejects the event and
    // reports it through the configured `onError`. Coercing a missing amount to
    // zero would record an event that looks perfectly reconciled and hide the problem.
    amount: { minor: amount, currency: String(obj.currency ?? "") },
    ...(parent != null ? { parentExternalId: String(parent) } : {}),
    ...(status != null ? { status } : {}),
    ...(environment != null ? { environment } : {}),
    ...(typeof obj.created === "number" ? { occurred_at: new Date(obj.created * 1000) } : {}),
    metadata: { stripe_event: event.id, stripe_object: kind },
  });
}

/**
 * `customer.subscription.*` — the recurring container a charge is expected to
 * arrive in. Not money movement; it's what lets reconciliation notice a billing
 * period that produced no charge at all.
 */
function captureSubscription(fi: FinIntegrityClient, event: any, obj: any, environment?: string): void {
  const status = SUBSCRIPTION_STATUS[String(obj.status)];
  if (!status) return; // see SUBSCRIPTION_STATUS — unmapped statuses expect no charge

  const item = obj.items?.data?.[0];
  const price = item?.price;
  const interval = price?.recurring?.interval;
  // Stripe moved the period from the subscription onto the item in 2025-03-31; read both.
  const periodStart = obj.current_period_start ?? item?.current_period_start;
  const periodEnd = obj.current_period_end ?? item?.current_period_end;

  fi.processor.recordSubscription({
    source: "stripe",
    external_id: String(obj.id),
    status,
    amount: { minor: price?.unit_amount, currency: String(price?.currency ?? obj.currency ?? "") },
    ...(INTERVALS.has(interval) ? { interval } : {}),
    ...(typeof periodStart === "number" ? { currentPeriodStart: new Date(periodStart * 1000) } : {}),
    ...(typeof periodEnd === "number" ? { currentPeriodEnd: new Date(periodEnd * 1000) } : {}),
    ...(environment != null ? { environment } : {}),
    // The subscription's own `created` is its birth, not this state change.
    ...(typeof event.created === "number" ? { occurred_at: new Date(event.created * 1000) } : {}),
    metadata: { stripe_event: event.id, stripe_object: "subscription" },
  });
}

/**
 * `invoice.paid` — a subscription's actual charge. Tagging it with `subscriptionId`
 * is what lets the engine pair the charge to its billing period; without it every
 * renewal looks unpaid.
 */
function captureInvoice(fi: FinIntegrityClient, event: any, obj: any, environment?: string): void {
  // Stripe moved this under `parent` in 2025-04-30; read both.
  const subscription = obj.subscription ?? obj.parent?.subscription_details?.subscription;
  if (!subscription) return; // a one-off invoice isn't a subscription charge

  const reference = obj.metadata?.reference ?? obj.metadata?.order_id ?? obj.charge ?? obj.id;

  fi.capture({
    side: "processor",
    type: "payment",
    source: "stripe",
    reference: String(reference),
    external_id: String(obj.id),
    amount: { minor: obj.amount_paid, currency: String(obj.currency ?? "") },
    subscriptionId: String(subscription),
    // "succeeded", never Stripe's own invoice status. An invoice says "paid",
    // which is not a financial_event_status — the server rejects the event, the
    // renewal charge never lands, and reconciliation reports the subscription as
    // never charged: a false missing_subscription_charge every single cycle.
    // We only get here from invoice.paid, so the money did move.
    status: "succeeded",
    ...(environment != null ? { environment } : {}),
    ...(typeof obj.created === "number" ? { occurred_at: new Date(obj.created * 1000) } : {}),
    metadata: { stripe_event: event.id, stripe_object: "invoice", invoice_status: obj.status },
  });
}
