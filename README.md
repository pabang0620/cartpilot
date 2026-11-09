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

## For judges

Live demo: https://cartpilot.35-216-2-121.sslip.io. Follow "Try the full story" on the left. The PayPal Sandbox test buyer is shown in the payment dialog. After paying, press "Seller demo: mark as shipped", then ask about the order, a refund and a claim. "Start over" resets the session.

## Outage fallback

If Claude, Channel3 or PayPal Sandbox is unreachable or its key stops working (expired, revoked, out of credit), that integration switches to the built-in mock data at runtime, so the hosted demo keeps working end to end. The mode badges in the header show which services are live. Business errors such as an over-limit refund are not treated as outages.

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

## Try it (judges)

1. Open the demo and type: `I need two camping chairs for a festival, under $300 total. Light and comfortable.`
2. Click **Review & pay**, then **Pay with PayPal**. In Sandbox, log in with a PayPal sandbox **personal** account and approve.
3. Back in the app, click **Seller: simulate shipment** on the order, then ask `Where are my chairs?`
4. Ask `One chair arrived with a broken leg. Refund that one.` and click **Approve refund**.
5. Ask `The other chair never arrived. Open a claim.` In Sandbox the agent drafts the claim for the PayPal Resolution Center and follows it with `list_disputes`.

## Hosting notes

- Set `PUBLIC_URL` and `APP_URL` to the public URL so PayPal can redirect back.
- State is in memory (demo scope). A restart clears sessions.

## License

MIT, see [LICENSE](LICENSE).
