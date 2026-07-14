# @fin-integrity/express

Express adapter for [**fin-integrity**](https://github.com/HatemSaadallah/fin-integrity-node) — _reconciliation-as-you-code_. Capture incoming **Stripe webhooks** (signature-verified) and flush events per response, on top of the core [`@fin-integrity/node`](https://github.com/HatemSaadallah/fin-integrity-node) client.

## Install

```bash
npm install @fin-integrity/node @fin-integrity/express stripe
```

## Usage

```ts
import express from "express";
import Stripe from "stripe";
import { init } from "@fin-integrity/node";
import { stripeWebhookHandler, flushOnResponse } from "@fin-integrity/express";

const fi = init({ apiKey: process.env.FIN_INTEGRITY_KEY! });
const stripe = new Stripe(process.env.STRIPE_KEY!);
const app = express();

// Drain queued events after each response finishes.
app.use(flushOnResponse(fi));

// Capture Stripe webhooks. The raw body parser is required for signature verification.
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler(fi, { stripe, secret: process.env.STRIPE_WEBHOOK_SECRET! }),
);
```

Set `metadata.reference` on your Stripe objects to control the reconciliation key. For the ledger side, use the core client's `fi.ledger.record(...)` wherever you write to your books.

## API

- **`stripeWebhookHandler(fi, { stripe, secret })`** → an Express handler that verifies the Stripe signature and captures the event's payment/refund as a fin-integrity processor event. Fail-open: a capture error never breaks the webhook ack.
- **`flushOnResponse(fi)`** → middleware that calls `fi.flush()` when each response finishes.

## License

[MIT](./LICENSE) © fin-integrity
