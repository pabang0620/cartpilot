import { runTool } from './tools.js'

// Rule-based stand-in for Claude when ANTHROPIC_API_KEY is missing.
// It calls the same tools in the same order the real agent would.

const WORD_NUMBERS = { one: 1, a: 1, an: 1, two: 2, pair: 2, three: 3, four: 4, five: 5, six: 6 }
const FILLER = /\b(i|need|want|would|like|please|find|me|get|buy|some|a|an|the|for|my|in|total|budget|under|within|below|max|maximum|up|to|of|usd|dollars|and|that|are|is|with|around|cheap|good)\b/g

function parseBudget(text) {
  const match = text.match(/(?:under|within|below|max(?:imum)?|budget(?: of)?|up to|less than)\s*\$?\s*(\d+(?:\.\d+)?)/i) || text.match(/\$\s*(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

function parseQuantity(text) {
  const cleaned = text.replace(/\$\s*\d+(\.\d+)?/g, ' ').replace(/(under|within|below|budget|up to|less than)\s*\d+(\.\d+)?/gi, ' ')
  const digit = cleaned.match(/\b(\d{1,2})\s+[a-z]/i)
  if (digit) return Math.min(10, Number(digit[1]))
  const word = cleaned.toLowerCase().match(/\b(two|three|four|five|six|pair)\b/)
  return word ? WORD_NUMBERS[word[1]] : 1
}

function parseQuery(text) {
  return text
    .toLowerCase()
    .replace(/\$\s*\d+(\.\d+)?/g, ' ')
    .replace(/\b\d+(\.\d+)?\b/g, ' ')
    .replace(/\b(two|three|four|five|six|pair)\b/g, ' ')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim() || text
}

async function call(session, events, name, input) {
  const outcome = await runTool(session, name, input)
  events.push({ tool: name, source: outcome.source, ok: outcome.ok, input })
  return outcome
}

function latestPaidOrder(orders) {
  return [...orders].reverse().find((o) => o.capture_id) || null
}

const usd = (n) => `$${Number(n).toFixed(2)}`

async function shop(session, events, text) {
  const budget = parseBudget(text)
  const quantity = parseQuantity(text)
  const query = parseQuery(text)
  if (budget) await call(session, events, 'set_budget', { amount_usd: budget })
  const cap = session.budget
  const perUnit = cap ? Math.floor((cap / quantity) * 100) / 100 : undefined
  const search = await call(session, events, 'search_products', { query, max_price: perUnit, limit: 6 })
  const results = search.ok ? search.result.results : []
  if (!results.length) {
    return `I could not find "${query}"${perUnit ? ` at ${usd(perUnit)} or less each` : ''}. Try a broader description or a higher budget.`
  }
  const candidates = results.slice(0, 3)
  for (const c of candidates.slice(0, 2)) await call(session, events, 'get_product_details', { product_id: c.product_id })
  const pick = candidates.find((c) => !cap || c.price * quantity <= cap) || candidates[0]
  const cart = await call(session, events, 'propose_cart', {
    items: [{ product_id: pick.product_id, quantity, reason: `Best match for "${query}" that fits the budget (${pick.key_features.slice(0, 2).join(', ')}).` }],
    summary: `${quantity} x ${pick.title}`,
  })
  const table = ['| Option | Price | Retailer | Highlights |', '|---|---|---|---|', ...candidates.map((c) => `| ${c.title}${c.product_id === pick.product_id ? ' (pick)' : ''} | ${usd(c.price)} | ${c.retailer} | ${c.key_features.slice(0, 2).join(', ')} |`)].join('\n')
  if (!cart.ok) return `${table}\n\n${cart.result.error}`
  const remaining = cart.result.remaining_budget_usd
  return `I compared ${candidates.length} options from Channel3:\n\n${table}\n\nCart: ${quantity} x **${pick.title}** for ${usd(cart.result.cart_total_usd)}${remaining != null ? `, leaving ${usd(remaining)} of your ${usd(cap)} budget` : ''}.\n\nNext: click **Review & pay** and approve on PayPal.`
}

async function track(session, events) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no paid orders yet.'
  const tracking = await call(session, events, 'get_shipment_tracking', { order_id: order.order_id })
  const trackers = tracking.ok ? tracking.result.trackers || [] : []
  if (!trackers.length) return `Order ${order.order_id} is paid (capture ${order.capture_id}) but the seller has not added tracking yet.`
  const t = trackers[trackers.length - 1]
  return `Order ${order.order_id}: **${t.status}** with ${t.carrier}, tracking number ${t.tracking_number}.`
}

async function refund(session, events, text) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no paid orders to refund.'
  const partial = /\b(one|a single|1)\b/i.test(text) && order.items.some((i) => i.quantity > 1)
  const amount = partial ? order.items[0].unit_price_usd : undefined
  const reason = /broken|damaged|defect/i.test(text) ? 'Item arrived damaged' : 'Shopper requested a refund'
  const req = await call(session, events, 'request_refund', { order_id: order.order_id, amount_usd: amount, reason })
  if (!req.ok) return req.result.error
  return `I prepared a ${partial ? 'partial ' : ''}refund of ${usd(req.result.amount_usd)} on order ${order.order_id} (${reason.toLowerCase()}). Nothing is refunded until you click **Approve refund**.`
}

async function claim(session, events, text) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no paid orders to file a claim on.'
  const open = order.disputes.find((d) => d.status !== 'RESOLVED')
  if (open && /resolve|settle|accept/i.test(text)) {
    const req = await call(session, events, 'request_dispute_resolution', { dispute_id: open.dispute_id, note: 'Seller accepts the claim and refunds the buyer' })
    return req.ok ? `Ready to settle dispute ${open.dispute_id}. Click **Approve** to accept the claim and refund it.` : req.result.error
  }
  const notReceived = /never|not received|didn.?t (arrive|come)|missing|lost/i.test(text)
  const amount = order.items[0].quantity > 1 ? order.items[0].unit_price_usd : Math.min(order.refundable_usd, order.items[0].unit_price_usd)
  const filed = await call(session, events, 'open_claim', {
    order_id: order.order_id,
    reason: notReceived ? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' : 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    amount_usd: amount,
    message: notReceived ? `One unit of ${order.items[0].title} was never delivered.` : `${order.items[0].title} does not match the description.`,
  })
  if (!filed.ok) return filed.result.error
  await call(session, events, 'list_disputes', {})
  if (filed.result.filed) return `Claim ${filed.result.dispute_id} is open for ${usd(amount)}. I will follow it with PayPal disputes. Say "resolve the claim" to settle it.`
  return `I drafted your claim for ${usd(amount)}. Submit it in the PayPal Resolution Center (${filed.result.resolution_center_url}), then ask me to check its status.`
}

export async function runMockAgent(session, text) {
  const events = []
  const t = text.toLowerCase()
  let reply
  if (/claim|dispute|never arrived|not received|didn.?t arrive|missing/.test(t)) reply = await claim(session, events, t)
  else if (/refund|money back|broken|damaged|return it/.test(t)) reply = await refund(session, events, t)
  else if (/track|where is|where are|shipping status|delivered|arrive/.test(t)) reply = await track(session, events)
  else reply = await shop(session, events, text)
  return { reply: `${reply}\n\n_(Mock agent: set ANTHROPIC_API_KEY for Claude.)_`, events }
}
