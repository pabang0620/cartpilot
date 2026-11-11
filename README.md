# CartPilot

An AI shopping agent where **PayPal holds the money and each package is charged only when it is delivered**. Tell it what you need ("three camping chairs under $300"). It searches real products with **Channel3**, compares them and fills a cart inside a budget cap it can never raise. You approve a PayPal **authorization**: nothing is charged yet. Each delivery scan captures exactly that package. A package that never arrives is released and never charged. A damaged one goes to the merchant first, whose policy refunds that package's capture. No chargeback needed.

Built for the PayPal AI Hackathon 2026.

## What it does

| Step | Who | Tech |
|---|---|---|
| Understand the request, set the budget cap | Agent (Claude) | `set_budget` (can set or lower, never raise) |
| Search and compare products | Agent | Channel3 `/v1/search`, `/v1/products/{id}` |
| Build a cart inside the budget | Agent + server check | `propose_cart` (server prices it from Channel3 data) |
| Review summary, approve a hold | **Shopper** | PayPal Orders API `intent: AUTHORIZE` -> PayPal approval page -> `authorize` |
| Ship packages, delivery scan | Merchant / carrier (demo console) | Payments API partial `capture` per package (`final_capture` on the last), then Agent Toolkit `create_shipment_tracking` DELIVERED on that capture |
| "Where are my chairs?" | Agent | merchant shipment records + Agent Toolkit `get_shipment_tracking` per capture |
| Package never arrived | Agent prepares, **shopper approves**, merchant policy releases | Payments API `void` on what is still held |
| Package arrived damaged | Agent prepares, **shopper approves**, merchant policy refunds | Agent Toolkit `create_refund` on that package's capture, `get_refund` |
| Last resort claim | Agent drafts and follows | Agent Toolkit `list_disputes`, `get_dispute`, `accept_dispute_claim` (merchant side) |

The shopper's agent never moves money. It can only create request cards. The shopper approves sending them, and the merchant policy (the PayPal Sandbox business account in the demo) runs the PayPal call.

## Architecture

```
React (Vite) UI ──> Express API ──> Claude tool loop (claude-sonnet-5-5, @anthropic-ai/sdk)
                     │               ├─ Channel3 REST (search, product detail)
                     │               ├─ PayPal Agent Toolkit (tool JSON schemas -> Claude tools,
                     │               │    handleToolCall -> PayPal Sandbox): tracking, refunds, disputes
                     │               └─ App tools (budget, cart, request cards) with server-side guards
                     ├─ PayPal Orders + Payments REST: authorize, capture per package, void
                     └─ Merchant policy + demo merchant console (ship, delivery scan)
```

- The Agent Toolkit creates CAPTURE orders only, so the authorize / capture-on-delivery / void flow calls the PayPal REST APIs directly. Everything after a capture goes through the toolkit.
- PayPal shipment trackers attach to captures, not authorizations, so each tracker is added the moment its package is captured.
- A PayPal authorization holds funds for 29 days with a 3-day honor period; longer deliveries would reauthorize.
- The toolkit is created with `context: { sandbox: true }`; without it the toolkit targets the live API.
- Prices and capture amounts always come from Channel3 data cached on the server, never from model output.

## Project structure

```
server/
  index.js            Express app, static client, demo limits, live-window check
  routes.js           HTTP API: session, state, budget, chat
  paymentRoutes.js    Checkout (authorize), PayPal return/cancel, request approvals, merchant policy, demo merchant console
  http.js             Shared HTTP helpers
  agent/claudeAgent.js  Claude tool loop and system prompt
  agent/accountAgent.js Local development only: same tools through the Claude Agent SDK and a Claude Code login
  agent/tools.js      Tools the model may call (search, cart, tracking, refund/claim drafts) with server-side guards
  agent/mockAgent.js  Rule-based stand-in used when Claude is unavailable
  integrations/       PayPal Agent Toolkit + REST authorize/capture/void (+ mock), Channel3 (+ mock catalog)
  services.js         Money math per package: charged, on hold, never charged, refundable, reserved
  store.js            In-memory sessions, orders, approvals, activity log
  fallback.js         Outage detection and the post-hackathon cutoff
  demoLimits.js       Per-IP and daily chat caps for the public demo
client/src/           React UI: chat on the left, purchase journey on the right
test/                 node:test suites (money guards end to end, fallback rules)
```

## Tests

`npm test` starts the app in mock mode and checks the money guards end to end: checkout only holds money, each delivery captures one package once, the last delivery is the final capture, a lost package is released and voided, refunds are per package and never exceed its capture, one authorization per cart, nothing is held after cancel or after the cap is lowered, session isolation, outage detection and the 2026-12-21 cutoff. `npm run smoke` walks the full story against a running server.

## For judges

Live demo: https://cartpilot.35-216-2-121.sslip.io

1. Click step 1 of "Try the full story": `I need three camping chairs for a festival, under $300 total. Light and comfortable.`
2. Click **Review & pay**, then **Approve ... hold with PayPal**. Log in with the PayPal Sandbox test buyer shown in the payment dialog and approve. It is a sandbox account with fake money only, which is why the server exposes it.
3. Back in the app the total is **On hold**, $0 charged. In the **Demo merchant console** press **Ship 3 packages**, then **Delivery scan PKG-1** and **PKG-2**. Each scan charges one chair. Leave PKG-3 in transit.
4. Ask `Where are my chairs?`, then `One chair arrived with a broken leg. Refund that one.` and click **Send refund request**.
5. Ask `The third chair never arrived.` and click **Release from hold**. You end up charged for one chair only.
6. **Start over** at the top resets the session.

## Outage fallback

If Claude, Channel3 or PayPal Sandbox is unreachable or its key stops working (expired, revoked, out of credit), that integration switches to the built-in mock data at runtime, so the hosted demo keeps working end to end. The mode badges in the header show which services are live. Business errors such as an over-limit refund are not treated as outages. After the hackathon results (end of 2026-12-21, KST) the server stops calling Claude and Channel3 for good and runs on the built-in data.

## Run it

Requirements: Node 20+.

```bash
npm install
cp .env.example .env      # optional: leave keys empty for MOCK mode
npm run build
npm start                 # http://localhost:3001
```

Each integration falls back to MOCK independently when its key is missing:

| Key | Live | Mock |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude agent | Rule-based agent that calls the same tools |
| `LLM_BACKEND=account` (local only) | Claude through the Claude Agent SDK and your Claude Code login, no API key | - |
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | PayPal Sandbox (REST + Agent Toolkit) | In-memory PayPal with the same response shapes and a local approval page |
| `CHANNEL3_API_KEY` | Channel3 catalog | 24 built-in products |

The badges at the top of the page show which mode each integration is in. `FORCE_MOCK=1` forces all mocks.

### Development

```bash
npm run dev:server        # API on :3001 (restarts on change)
npm run dev:client        # Vite on :5173, proxies /api and /mock-paypal
```

Set `APP_URL=http://localhost:5173` so the PayPal return lands on the Vite server.

### Smoke test

With the server running (MOCK mode is enough):

```bash
BASE=http://localhost:3001 npm run smoke
```

It runs the whole loop over HTTP: shop, checkout, PayPal approve (hold), ship, delivery captures, track, refund one package, release the lost one, plus guard checks (over-refund, foreign session, double payment).

## Hosting notes

- Set `PUBLIC_URL` and `APP_URL` to the public URL so PayPal can redirect back.
- State is in memory (demo scope). A restart clears sessions.

## License

MIT, see [LICENSE](LICENSE).
