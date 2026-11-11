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
  return [...orders].reverse().find((o) => o.authorization_id) || null
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
  return `I compared ${candidates.length} ${candidates.length === 1 ? 'option' : 'options'} from Channel3:\n\n${table}\n\nCart: ${quantity} x **${pick.title}** for ${usd(cart.result.cart_total_usd)}${remaining != null ? `, leaving ${usd(remaining)} of your ${usd(cap)} budget` : ''}.\n\nNext: click **Review & pay** and approve on PayPal.`
}

const PACKAGE_STATUS = { awaiting_shipment: 'waiting to ship', in_transit: 'in transit', delivered: 'delivered and charged', released: 'released, not charged' }

async function track(session, events) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no approved orders yet.'
  const tracking = await call(session, events, 'get_shipment_tracking', { order_id: order.order_id })
  const packages = tracking.ok ? tracking.result.packages : order.packages
  const rows = packages.map((p) => `| ${p.package_id} | ${p.item} | ${PACKAGE_STATUS[p.status] || p.status} | ${p.tracking_number ? `${p.carrier} ${p.tracking_number}` : '-'} |`)
  return [`Order ${order.order_id}: charged ${usd(order.charged_usd)}, on hold ${usd(order.on_hold_usd)}.`, '', '| Package | Item | Status | Tracking |', '|---|---|---|---|', ...rows].join('\n')
}

async function refund(session, events, text) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no approved orders to refund.'
  const pkg = order.packages.find((p) => p.status === 'delivered' && p.refundable_usd > 0)
  if (!pkg) return 'No delivered package can be refunded yet. Packages that have not arrived are not charged.'
  const reason = /broken|damaged|defect/i.test(text) ? 'Item arrived damaged' : 'Shopper requested a refund'
  const req = await call(session, events, 'request_refund', { order_id: order.order_id, package_id: pkg.package_id, reason })
  if (!req.ok) return req.result.error
  return `I prepared a refund request for ${pkg.package_id} (${usd(req.result.amount_usd)}, ${reason.toLowerCase()}). Nothing is sent to the merchant until you click **Approve**.`
}

async function missing(session, events) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no approved orders.'
  const open = order.packages.filter((p) => p.status === 'in_transit' || p.status === 'awaiting_shipment')
  const pkg = open.find((p) => p.carrier_reported_lost) || open[0]
  if (!pkg) return 'Every package on this order is already delivered or released.'
  const req = await call(session, events, 'report_missing_package', { order_id: order.order_id, package_id: pkg.package_id, reason: 'Package did not arrive' })
  if (!req.ok) return req.result.error
  return `${pkg.package_id} has no delivery scan, so it was never charged. I prepared a request to release its ${usd(pkg.price_usd)} from the PayPal hold. Click **Approve** to send it.`
}

async function claim(session, events, text) {
  const list = await call(session, events, 'list_my_orders', {})
  const order = latestPaidOrder(list.result.orders)
  if (!order) return 'You have no approved orders to file a claim on.'
  const open = order.disputes.find((d) => d.status !== 'RESOLVED')
  if (open && /resolve|settle|accept/i.test(text)) {
    const req = await call(session, events, 'request_dispute_resolution', { dispute_id: open.dispute_id, note: 'Seller accepts the claim and refunds the buyer' })
    return req.ok ? `Ready to ask the merchant to settle dispute ${open.dispute_id}. Click **Approve** to send it.` : req.result.error
  }
  const pkg = order.packages.find((p) => p.status === 'delivered' && p.refundable_usd > 0)
  if (!pkg) return 'Claims are only for delivered packages. Packages that did not arrive are never charged.'
  const filed = await call(session, events, 'open_claim', {
    order_id: order.order_id,
    package_id: pkg.package_id,
    reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    amount_usd: pkg.refundable_usd,
    message: `${pkg.item} does not match the description.`,
  })
  if (!filed.ok) return filed.result.error
  await call(session, events, 'list_disputes', {})
  if (filed.result.filed) return `Claim ${filed.result.dispute_id} is open for ${usd(pkg.refundable_usd)}. Say "resolve the claim" to ask the merchant to settle it.`
  return `I drafted your claim. Submit it in the PayPal Resolution Center (${filed.result.resolution_center_url}), then ask me to check its status.`
}

export async function runMockAgent(session, text) {
  const events = []
  const t = text.toLowerCase()
  let reply
  if (/claim|dispute/.test(t)) reply = await claim(session, events, t)
  else if (/never arrived|not received|didn.?t (arrive|come)|missing|lost/.test(t)) reply = await missing(session, events)
  else if (/refund|money back|broken|damaged|return it/.test(t)) reply = await refund(session, events, t)
  else if (/track|where is|where are|shipping status|delivered|arrive/.test(t)) reply = await track(session, events)
  else reply = await shop(session, events, text)
  return { reply: `${reply}\n\n_(Answered by the built-in rule agent, which calls the same tools. Claude is off or the public demo limit was reached.)_`, events }
}
