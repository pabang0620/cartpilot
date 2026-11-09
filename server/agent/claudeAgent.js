import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { claudeTools, runTool } from './tools.js'

const MAX_STEPS = 10

const SYSTEM_PROMPT = `You are CartPilot, a shopping agent that finds products, fills a cart inside the shopper's budget, and handles everything after the purchase (tracking, refunds, claims). Payments run on PayPal sandbox through the PayPal Agent Toolkit; products come from Channel3.

How you work:
- When the shopper states a budget, call set_budget first. Treat the budget as the total including shipping.
- Search with search_products, often more than once with different angles. Compare 2 to 4 strong candidates on price, weight, comfort, retailer and fit to the request, then pick.
- Quote only prices that came back from tools. Never invent products, prices or order ids.
- Call propose_cart with your picks. If it is rejected for budget, adjust and try again, and tell the shopper what you changed.
- You never charge money. After propose_cart, tell the shopper to click "Review & pay" and approve on PayPal.
- For any after-purchase question, call list_my_orders first. Use get_shipment_tracking for delivery, request_refund for refunds (partial refunds use the item price times affected quantity), open_claim for items not received or not as described, list_disputes and get_dispute to follow claims, request_dispute_resolution to settle one.
- request_refund and request_dispute_resolution only create an approval card. Say clearly that nothing happens until the shopper clicks Approve.
- The shopper approves or rejects cards outside the chat. Read their current status from list_my_orders (approval_cards) before mentioning them; never assume a card is still waiting.

Style: short and concrete. Use a small markdown table when comparing products. End with the one action the shopper should take next.`

let client = null

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey })
  return client
}

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
}

export async function runClaudeAgent(session, userText) {
  const historyLength = session.messages.length
  try {
    return await agentTurn(session, userText)
  } catch (err) {
    // Roll back a half-finished turn so the history never ends on an unanswered tool_use.
    session.messages.length = historyLength
    throw err
  }
}

async function agentTurn(session, userText) {
  const events = []
  const last = session.messages[session.messages.length - 1]
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: userText })
  } else {
    session.messages.push({ role: 'user', content: userText })
  }
  const tools = claudeTools()

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const response = await getClient().beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages: session.messages,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })

    // Keep the full content (thinking, fallback blocks) so later turns stay valid.
    session.messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'refusal') {
      return { reply: 'I cannot help with that request. Try asking about a product, an order, a refund or a claim.', events }
    }
    if (response.stop_reason === 'pause_turn') continue
    if (response.stop_reason !== 'tool_use') {
      return { reply: textOf(response.content) || 'Done.', events }
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use')
    const results = []
    for (const use of toolUses) {
      const outcome = await runTool(session, use.name, use.input)
      events.push({ tool: use.name, source: outcome.source, ok: outcome.ok, input: use.input })
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(outcome.result).slice(0, 12000),
        is_error: !outcome.ok,
      })
    }
    session.messages.push({ role: 'user', content: results })
  }

  return { reply: 'I stopped after several steps. Tell me what to focus on and I will continue.', events }
}
