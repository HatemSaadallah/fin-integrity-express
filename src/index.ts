import type { FinIntegrityClient, EventType } from "@fin-integrity/node";

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
 * Express handler that verifies an incoming Stripe webhook and captures its
 * payment/refund events. Mount with the raw body parser so signature verification
 * works: `app.post("/webhooks/stripe", express.raw({ type: "application/json" }), handler)`.
 */
export function stripeWebhookHandler(
  fi: FinIntegrityClient,
  opts: { stripe: any; secret: string },
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
      captureStripeWebhook(fi, event);
    } catch {
      /* fail-open — never break the webhook ack */
    }
    res.json({ received: true });
  };
}

/** Middleware that flushes queued events after each response finishes. */
export function flushOnResponse(fi: FinIntegrityClient) {
  return (_req: ReqLike, res: ResLike, next: Next): void => {
    res.on("finish", () => void fi.flush());
    next();
  };
}

function captureStripeWebhook(fi: FinIntegrityClient, event: any): void {
  const obj = event?.data?.object;
  if (!obj || typeof obj !== "object") return;
  const kind: string = obj.object;
  let type: EventType;
  if (kind === "refund") type = "refund";
  else if (kind === "charge" || kind === "payment_intent") type = "payment";
  else return;

  const amount = type === "refund" ? obj.amount : obj.amount_received ?? obj.amount;
  const reference =
    obj.metadata?.reference ??
    obj.metadata?.order_id ??
    (type === "refund" ? obj.charge ?? obj.payment_intent ?? obj.id : obj.id);

  fi.capture({
    side: "processor",
    type,
    source: "stripe",
    reference: String(reference),
    external_id: String(obj.id),
    amount: { minor: typeof amount === "number" ? amount : 0, currency: String(obj.currency ?? "") },
    ...(obj.status ? { status: String(obj.status) } : {}),
    ...(typeof obj.created === "number" ? { occurred_at: new Date(obj.created * 1000) } : {}),
    metadata: { stripe_event: event.id, stripe_object: kind },
  });
}
