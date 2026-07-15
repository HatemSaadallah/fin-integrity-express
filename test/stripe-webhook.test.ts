import { describe, it, expect, vi } from "vitest";
import { FinIntegrityClient } from "@fin-integrity/node";
import type { EventEnvelope, Transport } from "@fin-integrity/node";
import { stripeWebhookHandler, flushOnResponse } from "../src/index.js";

// Each client registers process listeners; keep the suite's output clean.
process.setMaxListeners(50);

class Capture implements Transport {
  sent: EventEnvelope[] = [];
  async send(batch: EventEnvelope[]): Promise<void> {
    this.sent.push(...batch);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const stripeOk = (event: any) => ({ webhooks: { constructEvent: () => event } });
const stripeBadSig = () => ({
  webhooks: {
    constructEvent: () => {
      throw new Error("no signatures found matching the expected signature");
    },
  },
});

const req = { body: Buffer.from("{}"), headers: { "stripe-signature": "t=1,v1=abc" } };

function mkRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    finishHandlers: [] as (() => void)[],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: any) {
      res.body = b;
    },
    send(b: any) {
      res.body = b;
    },
    on(ev: string, cb: () => void) {
      if (ev === "finish") res.finishHandlers.push(cb);
    },
  };
  return res;
}

/** Drive one webhook through the handler and return what reached the transport. */
async function deliver(event: any, opts: { onError?: (e: unknown) => void } = {}) {
  const t = new Capture();
  const fi = new FinIntegrityClient({ transport: t, ...(opts.onError ? { onError: opts.onError } : {}) });
  const res = mkRes();
  stripeWebhookHandler(fi, { stripe: stripeOk(event) as any, secret: "whsec_test" })(req, res);
  await fi.flush();
  return { sent: t.sent, res };
}

const charge = (over: any = {}) => ({
  id: "ch_1",
  object: "charge",
  amount: 4999,
  currency: "usd",
  status: "succeeded",
  created: 1720000000,
  metadata: { reference: "order_77" },
  ...over,
});

const subscription = (over: any = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  current_period_start: 1720000000,
  current_period_end: 1722678400,
  items: { data: [{ price: { unit_amount: 2500, currency: "usd", recurring: { interval: "month" } } }] },
  ...over,
});

describe("stripeWebhookHandler", () => {
  it("rejects a bad signature with 400 and captures nothing", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t });
    const res = mkRes();
    stripeWebhookHandler(fi, { stripe: stripeBadSig() as any, secret: "whsec_test" })(req, res);
    await fi.flush();
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("signature verification failed");
    expect(t.sent).toHaveLength(0);
  });

  it("captures charge.succeeded as one payment in minor units, reference from metadata", async () => {
    const { sent, res } = await deliver({ id: "evt_1", created: 1720000005, data: { object: charge() } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      side: "processor",
      event_type: "payment",
      source: "stripe",
      reference: "order_77",
      external_id: "ch_1",
      amount: { minor: "4999", currency: "usd" },
      status: "succeeded",
    });
    expect(sent[0]!.occurred_at).toBe(new Date(1720000000 * 1000).toISOString());
    expect(res.body).toEqual({ received: true });
  });

  it("captures a refund, falling back to the charge it acts on for the reference", async () => {
    const { sent } = await deliver({
      id: "evt_2",
      data: { object: { id: "re_1", object: "refund", amount: 1500, currency: "usd", charge: "ch_1", metadata: {} } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: "refund",
      reference: "ch_1",
      external_id: "re_1",
      amount: { minor: "1500", currency: "usd" },
    });
  });

  // The regression: disputes used to be dropped on the floor entirely.
  it("captures a lost dispute with status lost and the charge it acts on", async () => {
    const { sent } = await deliver({
      id: "evt_3",
      data: {
        object: { id: "dp_1", object: "dispute", amount: 4999, currency: "usd", status: "lost", charge: "ch_1", created: 1720000100, metadata: {} },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: "dispute",
      status: "lost",
      reference: "ch_1",
      external_id: "dp_1",
      parent_external_id: "ch_1",
      amount: { minor: "4999", currency: "usd" },
    });
  });

  it("captures a won dispute too — the engine decides it isn't money-out", async () => {
    const { sent } = await deliver({
      id: "evt_4",
      data: { object: { id: "dp_2", object: "dispute", amount: 4999, currency: "usd", status: "won", charge: "ch_1", metadata: {} } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event_type: "dispute", status: "won", parent_external_id: "ch_1" });
  });

  it("folds Stripe's warning_* dispute statuses onto the accepted ones", async () => {
    const { sent } = await deliver({
      id: "evt_5",
      data: { object: { id: "dp_3", object: "dispute", amount: 100, currency: "usd", status: "warning_needs_response", charge: "ch_1", metadata: {} } },
    });
    expect(sent[0]).toMatchObject({ event_type: "dispute", status: "needs_response" });
  });

  it("skips a dispute whose status the ingest service would reject", async () => {
    const { sent, res } = await deliver({
      id: "evt_6",
      data: { object: { id: "dp_4", object: "dispute", amount: 100, currency: "usd", status: "charge_refunded", charge: "ch_1", metadata: {} } },
    });
    expect(sent).toHaveLength(0);
    expect(res.body).toEqual({ received: true });
  });

  it("keeps a dispute joined to the same reference as its charge", async () => {
    const { sent } = await deliver({
      id: "evt_7",
      data: {
        object: { id: "dp_5", object: "dispute", amount: 4999, currency: "usd", status: "lost", charge: "ch_1", metadata: { reference: "order_77" } },
      },
    });
    expect(sent[0]!.reference).toBe("order_77");
  });

  it("ignores object types it doesn't understand but still acks", async () => {
    const { sent, res } = await deliver({ id: "evt_8", data: { object: { id: "cus_1", object: "customer" } } });
    expect(sent).toHaveLength(0);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("acks even when capture throws internally (fail-open)", () => {
    const fi = { capture: () => { throw new Error("boom"); } } as any;
    const res = mkRes();
    const event = { id: "evt_9", data: { object: charge() } };
    expect(() => stripeWebhookHandler(fi, { stripe: stripeOk(event) as any, secret: "s" })(req, res)).not.toThrow();
    expect(res.body).toEqual({ received: true });
  });

  // A zero-amount event looks perfectly reconciled; never fabricate one.
  it("reports a missing amount via onError instead of recording a false zero", async () => {
    const onError = vi.fn();
    const { sent, res } = await deliver(
      { id: "evt_10", data: { object: charge({ amount: undefined }) } },
      { onError },
    );
    expect(sent).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain("integer");
    expect(res.body).toEqual({ received: true });
  });

  it("does not record a non-integer amount as zero either", async () => {
    const onError = vi.fn();
    const { sent } = await deliver({ id: "evt_11", data: { object: charge({ amount: "4999" }) } }, { onError });
    expect(sent).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
  });
});

describe("subscriptions", () => {
  it("records a created subscription with mapped status, interval, amount and periods", async () => {
    const { sent } = await deliver({ id: "evt_20", created: 1720000009, data: { object: subscription() } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      side: "processor",
      event_type: "subscription",
      source: "stripe",
      external_id: "sub_1",
      reference: "sub_1",
      status: "active",
      interval: "month",
      amount: { minor: "2500", currency: "usd" },
    });
    // unix seconds -> ISO
    expect(sent[0]!.current_period_start).toBe(new Date(1720000000 * 1000).toISOString());
    expect(sent[0]!.current_period_end).toBe(new Date(1722678400 * 1000).toISOString());
  });

  it("folds unpaid onto past_due", async () => {
    const { sent } = await deliver({ id: "evt_21", data: { object: subscription({ status: "unpaid" }) } });
    expect(sent[0]).toMatchObject({ event_type: "subscription", status: "past_due" });
  });

  it("skips a status that doesn't map rather than sending one the server rejects", async () => {
    for (const status of ["incomplete", "incomplete_expired"]) {
      const { sent, res } = await deliver({ id: "evt_22", data: { object: subscription({ status }) } });
      expect(sent, status).toHaveLength(0);
      expect(res.body).toEqual({ received: true });
    }
  });

  it("reads the period off the item when Stripe puts it there", async () => {
    const { sent } = await deliver({
      id: "evt_23",
      data: {
        object: subscription({
          current_period_start: undefined,
          current_period_end: undefined,
          items: {
            data: [
              {
                current_period_start: 1720000000,
                current_period_end: 1722678400,
                price: { unit_amount: 2500, currency: "usd", recurring: { interval: "month" } },
              },
            ],
          },
        }),
      },
    });
    expect(sent[0]!.current_period_end).toBe(new Date(1722678400 * 1000).toISOString());
  });

  it("survives a subscription payload with no items (fail-open, nothing recorded)", async () => {
    const onError = vi.fn();
    const { sent, res } = await deliver(
      { id: "evt_24", data: { object: subscription({ items: undefined }) } },
      { onError },
    );
    expect(sent).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    expect(res.body).toEqual({ received: true });
  });

  it("records invoice.paid as a payment carrying its subscription_id", async () => {
    const { sent } = await deliver({
      id: "evt_25",
      data: {
        object: {
          id: "in_1",
          object: "invoice",
          subscription: "sub_1",
          amount_paid: 2500,
          currency: "usd",
          status: "paid",
          charge: "ch_9",
          created: 1720000200,
          metadata: {},
        },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: "payment",
      external_id: "in_1",
      reference: "ch_9",
      subscription_id: "sub_1",
      amount: { minor: "2500", currency: "usd" },
    });
  });

  it("reads the subscription from `parent` on newer Stripe API versions", async () => {
    const { sent } = await deliver({
      id: "evt_26",
      data: {
        object: {
          id: "in_2",
          object: "invoice",
          parent: { subscription_details: { subscription: "sub_1" } },
          amount_paid: 2500,
          currency: "usd",
          metadata: {},
        },
      },
    });
    expect(sent[0]).toMatchObject({ external_id: "in_2", subscription_id: "sub_1" });
  });

  it("does not treat a one-off invoice as a subscription charge", async () => {
    const { sent, res } = await deliver({
      id: "evt_27",
      data: { object: { id: "in_3", object: "invoice", amount_paid: 2500, currency: "usd", metadata: {} } },
    });
    expect(sent).toHaveLength(0);
    expect(res.body).toEqual({ received: true });
  });

  // The pairing the missing_subscription_charge rule depends on: if the invoice
  // charge isn't tagged, every renewal looks unpaid and each one raises a false incident.
  it("pairs the subscription with its renewal charge via subscription_id", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t });
    const handle = (event: any) =>
      stripeWebhookHandler(fi, { stripe: stripeOk(event) as any, secret: "s" })(req, mkRes());

    handle({ id: "evt_28", created: 1720000000, data: { object: subscription() } });
    handle({
      id: "evt_29",
      data: {
        object: { id: "in_9", object: "invoice", subscription: "sub_1", amount_paid: 2500, currency: "usd", created: 1720000300, metadata: {} },
      },
    });
    await fi.flush();

    const sub = t.sent.find((e) => e.event_type === "subscription");
    const charge = t.sent.find((e) => e.event_type === "payment");
    expect(sub).toBeDefined();
    expect(charge).toBeDefined();
    expect(charge!.subscription_id).toBe(sub!.external_id);
  });
});

describe("flushOnResponse", () => {
  it("registers a finish handler that flushes queued events", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t });
    const res = mkRes();
    const next = vi.fn();

    flushOnResponse(fi)({ body: null, headers: {} }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.finishHandlers).toHaveLength(1);

    fi.processor.record({ type: "payment", source: "stripe", reference: "o1", external_id: "ch_1", amount: { minor: 100, currency: "usd" } });
    expect(t.sent).toHaveLength(0); // still queued

    res.finishHandlers[0]!(); // response finished
    await new Promise((r) => setTimeout(r, 0));
    expect(t.sent).toHaveLength(1);
  });
});
