# CartPilot

An AI shopping agent that finds, buys, and fixes. Tell it what you need ("two camping chairs under $300"). It searches real products with **Channel3**, compares them, fills a cart inside your budget, and you approve the payment on **PayPal**. After the order, the same agent tracks the shipment, prepares refunds, and files claims, all through the **PayPal Agent Toolkit**. Nothing that moves money happens without a human click.

Built for the PayPal AI Hackathon 2026.

## What it does

| Step | Who | Tech |
|---|---|---|
| Understand the request, set the budget cap | Agent (Claude) | `set_budget` (can set or lower, never raise) |
| Search and compare products | Agent | Channel3 `/v1/search`, `/v1/products/{id}` |
| Build a cart inside the budget | Agent + server check | `propose_cart` (server prices it from Channel3 data) |
| Review summary, pay | **Human** | PayPal Agent Toolkit `create_order` -> PayPal approval page -> `pay_order` |
| Ship (demo seller button) | Seller | Toolkit `create_shipment_tracking` |
| "Where is my order?" | Agent | Toolkit `get_order`, `get_shipment_tracking` |
| Partial or full refund | Agent prepares, **human approves** | Toolkit `create_refund`, `get_refund` |
| Claim for item not received / not as described | Agent drafts, follows | Toolkit `list_disputes`, `get_dispute`, `accept_dispute_claim` (after approval) |

Human approval points: budget cap, cart summary, PayPal approval screen, refund card, dispute card. The model is never given `create_order`, `pay_order` or `create_shipment_tracking`.

## Architecture

```
React (Vite) UI ──> Express API ──> Claude tool loop (claude-sonnet-5-5, @anthropic-ai/sdk)
                                     ├─ Channel3 REST (search, product detail)
                                     ├─ PayPal Agent Toolkit (@paypal/agent-toolkit/openai adapter:
                                     │    tool JSON schemas -> Claude tools, handleToolCall -> PayPal Sandbox)
                                     └─ App tools (budget, cart, approvals) with server-side guards
```

- PayPal tool schemas come straight from the toolkit (`getTools()`), so Claude sees PayPal's own tool descriptions.
- The toolkit is created with `context: { sandbox: true }`; without it the toolkit targets the live API.
- Prices shown and charged always come from Channel3 results cached on the server, never from model output.
- Orders, approvals and disputes are scoped to the browser session.

## Project structure

```
server/
  index.js            Express app, static client, demo limits, live-window check
  routes.js           HTTP API: session, chat, checkout, PayPal return/cancel, approvals, seller demo
  agent/claudeAgent.js  Claude tool loop and system prompt
  agent/tools.js      Tools the model may call (search, cart, tracking, refund/claim drafts) with server-side guards
  agent/mockAgent.js  Rule-based stand-in used when Claude is unavailable
  integrations/       PayPal Agent Toolkit (+ mock), Channel3 (+ mock catalog)
  services.js         Money math: refundable, reserved amounts, refunded status
  store.js            In-memory sessions, orders, approvals, activity log
  fallback.js         Outage detection and the post-hackathon cutoff
  demoLimits.js       Per-IP and daily chat caps for the public demo
client/src/           React UI: chat on the left, purchase journey on the right
test/                 node:test suites (money guards end to end, fallback rules)
```

## Tests

`npm test` starts the app in mock mode and checks the money guards end to end: one capture per cart, no capture after cancel or after the cap is lowered, refunds and claims never exceed what was paid, session isolation, outage detection and the 2026-12-21 cutoff. `npm run smoke` walks the full story against a running server.

## For judges

Live demo: https://cartpilot.35-216-2-121.sslip.io

1. Click step 1 of "Try the full story": `I need two camping chairs for a festival, under $300 total. Light and comfortable.`
2. Click **Review & pay**, then **Pay with PayPal**. Log in with the PayPal Sandbox test buyer shown in the payment dialog and approve. It is a sandbox account with fake money only, which is why the server exposes it.
3. Back in the app, click **Seller demo: mark as shipped**, then ask `Where are my chairs?`
4. Ask `One chair arrived with a broken leg. Refund that one.` and click **Approve refund**.
5. Ask `The other chair never arrived. Open a claim.` In the Sandbox a buyer opens claims in the PayPal Resolution Center, so the agent drafts the claim text and then follows it with `list_disputes` / `get_dispute`.
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
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | PayPal Sandbox through the Agent Toolkit | In-memory PayPal with the same response shapes and a local approval page |
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

It runs the whole loop over HTTP: shop, checkout, PayPal approve, capture, ship, track, partial refund, claim, settle, plus guard checks (over-refund, foreign session, double payment).

## Hosting notes

- Set `PUBLIC_URL` and `APP_URL` to the public URL so PayPal can redirect back.
- State is in memory (demo scope). A restart clears sessions.

## License

MIT, see [LICENSE](LICENSE).
