import { randomUUID } from 'node:crypto'
import { config, modes } from '../config.js'
import { searchProducts, getProduct, summarizeProduct, bestOffer, offerPrice } from '../integrations/channel3.js'
import { toolkitSchema, mockPaypal } from '../integrations/paypal.js'
import { logActivity, sessionOrders, getSessionOrder, addApproval, spentAmount } from '../store.js'
import { releaseEligibility } from '../merchant.js'
import { paypal, round2, captureIds, compactOrder, reservedAmount, syncDisputes, packageRefundable, orderByCapture } from '../services.js'

class ToolError extends Error {}

const SANDBOX_RESOLUTION_CENTER = 'https://www.sandbox.paypal.com/resolutioncenter'

function requireOrder(session, orderId) {
  const order = getSessionOrder(session, orderId)
  if (!order) throw new ToolError(`Order ${orderId} does not belong to this shopper.`)
  return order
}

function rememberProduct(session, product) {
  const offer = bestOffer(product)
  if (!offer) return null
  const summary = summarizeProduct(product)
  session.catalog.set(product.id, { ...summary, price: offerPrice(offer) })
  return summary
}

// Toolkit tools passed to Claude with the toolkit's own JSON schema.
function fromToolkit(name, run) {
  const { description, input_schema } = toolkitSchema(name)
  return { name, description, input_schema, source: 'paypal-agent-toolkit', run }
}

export const TOOLS = [
  {
    name: 'set_budget',
    source: 'app',
    description: 'Set the shopper\'s total spending cap in USD when they state one. You may set it the first time or lower it. Raising an existing cap is refused: only the shopper can raise it in the UI.',
    input_schema: {
      type: 'object',
      properties: { amount_usd: { type: 'number', description: 'Total budget cap in USD, including shipping.' } },
      required: ['amount_usd'],
      additionalProperties: false,
    },
    async run(session, { amount_usd }) {
      const amount = round2(Number(amount_usd))
      if (!(amount > 0)) throw new ToolError('Budget must be a positive number.')
      if (session.budget != null && amount > session.budget) {
        throw new ToolError(`Current cap is $${session.budget}. Raising it needs the shopper to edit the Budget field.`)
      }
      const spent = spentAmount(session)
      if (amount < spent) throw new ToolError(`$${spent} is already spent in this session, so the cap cannot go below that. For a per-item price limit use max_price in search_products.`)
      session.budget = amount
      return { budget_usd: amount }
    },
  },
  {
    name: 'search_products',
    source: 'channel3',
    description: 'Search real products across retailers with Channel3. Returns product_id, title, brand, best in-stock price and retailer. Run several focused searches when useful (for example by style or brand). Prices returned here are the only prices you may quote.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language product query, e.g. "lightweight folding camping chair".' },
        max_price: { type: 'number', description: 'Max price per unit in USD.' },
        min_price: { type: 'number', description: 'Min price per unit in USD.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results, default 6.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(session, { query, max_price, min_price, limit = 6 }) {
      let maxPrice = max_price
      if (session.budget != null) {
        const left = Math.max(0, round2(session.budget - spentAmount(session)))
        maxPrice = Math.min(maxPrice ?? left, left)
      }
      const products = await searchProducts({ query, minPrice: min_price, maxPrice, limit }, session.id)
      const results = products.map((p) => rememberProduct(session, p)).filter(Boolean)
      return { query, count: results.length, results }
    },
  },
  {
    name: 'get_product_details',
    source: 'channel3',
    description: 'Get full Channel3 details for one product: description, features and every retailer offer. Use before recommending when the search result is not enough.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
      additionalProperties: false,
    },
    async run(session, { product_id }) {
      const product = await getProduct(product_id)
      const summary = rememberProduct(session, product)
      return {
        ...summary,
        description: (product.description || '').slice(0, 600),
        materials: product.materials || null,
        offers: (product.offers || []).slice(0, 6).map((o) => ({ retailer: o.domain, price: offerPrice(o), currency: o.price?.currency, availability: o.availability, condition: o.condition || null })),
      }
    },
  },
  {
    name: 'propose_cart',
    source: 'app',
    description: 'Put the recommended items in the shopper\'s cart for review. Use only product_ids returned by search_products or get_product_details. The server prices the cart from Channel3 data and rejects it if it exceeds the budget. This does not charge anything: the shopper reviews and pays on PayPal.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 10 },
              reason: { type: 'string', description: 'One short sentence: why this pick.' },
            },
            required: ['product_id', 'quantity', 'reason'],
            additionalProperties: false,
          },
        },
        summary: { type: 'string', description: 'One sentence summary of the cart for the shopper.' },
      },
      required: ['items', 'summary'],
      additionalProperties: false,
    },
    async run(session, { items, summary }) {
      const lines = items.map((item) => {
        const product = session.catalog.get(item.product_id)
        if (!product) throw new ToolError(`Unknown product_id ${item.product_id}. Search for it first.`)
        const quantity = Math.max(1, Math.min(10, Math.floor(item.quantity)))
        return {
          productId: product.product_id,
          title: product.title,
          brand: product.brand,
          image: product.image,
          retailer: product.retailer,
          url: product.url,
          quantity,
          unitPrice: product.price,
          lineTotal: round2(product.price * quantity),
          reason: item.reason,
        }
      })
      const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0))
      const shipping = round2(config.shippingFlat)
      const total = round2(subtotal + shipping)
      const spent = spentAmount(session)
      const left = session.budget != null ? round2(session.budget - spent) : null
      if (left != null && total > left) {
        const already = spent > 0 ? ` ($${spent} of the $${session.budget} cap is already spent)` : ''
        throw new ToolError(`Cart total $${total} is over the $${left} left in the budget${already} by $${round2(total - left)}. Choose cheaper items or fewer units.`)
      }
      session.cart = { id: randomUUID(), status: 'proposed', items: lines, subtotal, shipping, total, currency: 'USD', summary }
      return { cart_total_usd: total, subtotal_usd: subtotal, shipping_usd: shipping, budget_usd: session.budget, already_spent_usd: spent, remaining_budget_usd: left != null ? round2(left - total) : null, next_step: 'Shopper reviews the cart and clicks Review & pay.' }
    },
  },
  {
    name: 'list_my_orders',
    source: 'app',
    description: 'List this shopper\'s orders. Payment is authorized (held) on PayPal at checkout and each package is charged only when it is delivered, so every order shows charged_usd, on_hold_usd and released_usd, plus packages with status (awaiting_shipment, in_transit, delivered, released), tracking, estimated delivery and capture_id. Also returns approval_cards. Call this first for any after-purchase question.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(session) {
      const cards = [...session.approvals.values()].map((a) => ({ type: a.type, order_id: a.orderId, package_id: a.packageId || null, amount_usd: a.amount, status: a.status }))
      return { orders: sessionOrders(session).filter((o) => o.status !== 'VOIDED').map(compactOrder), approval_cards: cards }
    },
  },
  fromToolkit('get_order', async (session, args) => {
    requireOrder(session, args.id)
    return paypal(session, 'get_order', args)
  }),
  fromToolkit('get_shipment_tracking', async (session, args) => {
    const captures = captureIds(session)
    if (args.transaction_id && !args.order_id) {
      if (!captures.has(args.transaction_id)) throw new ToolError('Transaction does not belong to this shopper.')
      return paypal(session, 'get_shipment_tracking', { transaction_id: args.transaction_id })
    }
    if (!args.order_id) throw new ToolError('Pass order_id (all packages) or the capture_id of a delivered package as transaction_id.')
    const order = requireOrder(session, args.order_id)
    // PayPal keeps trackers on captures, so delivered packages are read from PayPal and packages
    // still in transit come from the merchant's shipment records.
    const delivered = order.packages.filter((p) => p.captureId)
    const paypalTrackers = []
    for (const p of delivered) {
      const result = await paypal(session, 'get_shipment_tracking', { transaction_id: p.captureId })
      paypalTrackers.push({ package_id: p.id, trackers: result.trackers || result })
    }
    return {
      packages: order.packages.map((p) => ({ package_id: p.id, item: p.title, status: p.status, carrier_reported_lost: !!p.lostAt, carrier: p.carrier, tracking_number: p.trackingNumber, estimated_delivery: p.eta, delivered_at: p.deliveredAt, charged: !!p.captureId })),
      paypal_trackers: paypalTrackers,
    }
  }),
  fromToolkit('get_refund', async (session, args) => {
    const owned = sessionOrders(session).some((o) => o.refunds.some((r) => r.refundId === args.refund_id))
    if (!owned) throw new ToolError('Refund does not belong to this shopper.')
    return paypal(session, 'get_refund', args)
  }),
  fromToolkit('list_disputes', async (session, args) => {
    const result = await paypal(session, 'list_disputes', args)
    const captures = captureIds(session)
    const items = (result.items || []).filter((d) => (d.disputed_transactions || []).some((t) => captures.has(t.seller_transaction_id)))
    syncDisputes(session, items)
    return { items }
  }),
  fromToolkit('get_dispute', async (session, args) => {
    const dispute = await paypal(session, 'get_dispute', args)
    const captures = captureIds(session)
    if (!(dispute.disputed_transactions || []).some((t) => captures.has(t.seller_transaction_id))) {
      throw new ToolError('Dispute does not belong to this shopper.')
    }
    syncDisputes(session, [dispute])
    return dispute
  }),
  {
    name: 'report_missing_package',
    source: 'app',
    description: 'For a package that has not been delivered, prepare a request to the merchant to release it from the PayPal hold, so the shopper is never charged for it. The merchant policy releases a package only when the carrier reported it lost or its estimated delivery date has passed; before that this tool refuses and explains when it becomes eligible. This only creates an approval card; after the shopper approves, the merchant releases it and PayPal voids what is still held. Use this instead of a refund or a claim for items that never arrived.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        package_id: { type: 'string', description: 'package_id from list_my_orders, e.g. PKG-3.' },
        reason: { type: 'string', description: 'Short reason shown to the shopper and the merchant.' },
      },
      required: ['order_id', 'package_id', 'reason'],
      additionalProperties: false,
    },
    async run(session, { order_id, package_id, reason }) {
      const order = requireOrder(session, order_id)
      const pkg = order.packages.find((p) => p.id === package_id)
      if (!pkg) throw new ToolError(`No package ${package_id} on this order.`)
      if (pkg.status === 'delivered') throw new ToolError(`${package_id} was delivered and charged. Use request_refund if it arrived damaged.`)
      if (pkg.status === 'released') throw new ToolError(`${package_id} is already released. The shopper is not charged for it.`)
      const check = releaseEligibility(pkg)
      if (!check.ok) throw new ToolError(`Not eligible for release yet: ${check.reason} Until then it stays on hold and is not charged.`)
      const waiting = [...session.approvals.values()].find((a) => a.type === 'release' && a.status === 'pending' && a.packageId === package_id)
      if (waiting) throw new ToolError('A release card for this package is already waiting for the shopper.')
      const approval = addApproval(session, { type: 'release', orderId: order.orderId, packageId: pkg.id, amount: pkg.amount, reason: reason.slice(0, 200), paypalTool: 'void_authorization' })
      return { approval_id: approval.id, status: 'pending_shopper_approval', amount_not_charged_usd: pkg.amount, why_eligible: check.reason }
    },
  },
  {
    name: 'request_refund',
    source: 'app',
    description: 'Prepare a refund request to the merchant for a delivered (charged) package, for example when it arrived damaged. This only creates an approval card; after the shopper approves, the merchant policy approves refunds up to the package price and the merchant side runs PayPal create_refund on that package\'s capture. Omit amount_usd for the full package price.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        package_id: { type: 'string', description: 'package_id of a delivered package from list_my_orders.' },
        amount_usd: { type: 'number', description: 'Refund amount. Omit for the full refundable amount of the package.' },
        reason: { type: 'string', description: 'Short reason shown to the shopper and sent as note_to_payer.' },
      },
      required: ['order_id', 'package_id', 'reason'],
      additionalProperties: false,
    },
    async run(session, { order_id, package_id, amount_usd, reason }) {
      const order = requireOrder(session, order_id)
      const pkg = order.packages.find((p) => p.id === package_id)
      if (!pkg) throw new ToolError(`No package ${package_id} on this order.`)
      if (!pkg.captureId) throw new ToolError(`${package_id} was not delivered, so it was never charged. Use report_missing_package instead.`)
      const refundable = packageRefundable(order, pkg)
      if (refundable <= 0) throw new ToolError(`${package_id} is already fully refunded.`)
      const reserved = reservedAmount(session, order, pkg.captureId)
      const available = round2(refundable - reserved.total)
      const held = [reserved.pendingRefunds ? `$${reserved.pendingRefunds} in a pending refund card` : '', reserved.openClaims ? `$${reserved.openClaims} in an open claim (resolve the claim instead of refunding twice)` : ''].filter(Boolean).join(' and ')
      if (available <= 0) throw new ToolError(`Nothing left to refund on ${package_id}: ${held}.`)
      const amount = round2(amount_usd ?? available)
      if (!(amount > 0) || amount > available) throw new ToolError(`Refund must be between $0.01 and $${available}${held ? ` (${held})` : ''}.`)
      const approval = addApproval(session, { type: 'refund', orderId: order.orderId, packageId: pkg.id, captureId: pkg.captureId, amount, reason: reason.slice(0, 200), paypalTool: 'create_refund' })
      return { approval_id: approval.id, status: 'pending_shopper_approval', amount_usd: amount, refundable_usd: refundable }
    },
  },
  {
    name: 'open_claim',
    source: 'app',
    description: 'Last resort only, when the merchant refuses: draft a PayPal buyer claim (dispute) for a delivered (charged) package that is not as described. Items that never arrived are never charged, so use report_missing_package for them. In sandbox the shopper submits the claim in the PayPal Resolution Center; in mock mode it is filed directly. Afterwards use list_disputes to follow it.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        package_id: { type: 'string' },
        reason: { type: 'string', enum: ['MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'] },
        amount_usd: { type: 'number', description: 'Disputed amount (at most the package price).' },
        message: { type: 'string', description: 'Claim message written for the shopper, factual and short.' },
      },
      required: ['order_id', 'package_id', 'reason', 'amount_usd', 'message'],
      additionalProperties: false,
    },
    async run(session, { order_id, package_id, reason, amount_usd, message }) {
      const order = requireOrder(session, order_id)
      const pkg = order.packages.find((p) => p.id === package_id)
      if (!pkg) throw new ToolError(`No package ${package_id} on this order.`)
      if (!pkg.captureId) throw new ToolError(`${package_id} was never charged, so there is nothing to claim. Use report_missing_package.`)
      const refundable = packageRefundable(order, pkg)
      const reserved = reservedAmount(session, order, pkg.captureId)
      const available = round2(refundable - reserved.total)
      if (available <= 0) throw new ToolError(`Nothing left to claim on ${package_id}.`)
      const amount = round2(amount_usd)
      if (!(amount > 0) || amount > available) throw new ToolError(`Claim amount must be between $0.01 and $${available}.`)
      order.claimDraft = { packageId: pkg.id, reason, amount, message: message.slice(0, 1000), createdAt: new Date().toISOString() }
      if (modes.paypal === 'mock') {
        const dispute = mockPaypal.openDispute({ captureId: pkg.captureId, amount, reason, message: order.claimDraft.message })
        order.disputes.push({ disputeId: dispute.dispute_id, captureId: pkg.captureId, status: dispute.status, reason, amount })
        logActivity(session, { source: 'paypal-agent-toolkit', tool: 'buyer_opens_dispute (mock)', origin: 'agent', ok: true })
        return { filed: true, dispute_id: dispute.dispute_id, status: dispute.status }
      }
      return { filed: false, resolution_center_url: SANDBOX_RESOLUTION_CENTER, capture_id: pkg.captureId, draft: order.claimDraft, next_step: 'Shopper pastes the draft in the PayPal Resolution Center. Then call list_disputes.' }
    },
  },
  {
    name: 'request_dispute_resolution',
    source: 'app',
    description: 'Ask the merchant to settle an open dispute in the shopper\'s favour. This only creates an approval card; after the shopper approves, the merchant policy accepts the claim with PayPal accept_dispute_claim.',
    input_schema: {
      type: 'object',
      properties: {
        dispute_id: { type: 'string' },
        note: { type: 'string', description: 'Short note recorded on the dispute.' },
      },
      required: ['dispute_id', 'note'],
      additionalProperties: false,
    },
    async run(session, { dispute_id, note }) {
      const dispute = await paypal(session, 'get_dispute', { dispute_id })
      const captures = captureIds(session)
      const txn = (dispute.disputed_transactions || []).find((t) => captures.has(t.seller_transaction_id))
      if (!txn) throw new ToolError('Dispute does not belong to this shopper.')
      if (dispute.status === 'RESOLVED') throw new ToolError('Dispute is already resolved.')
      const order = orderByCapture(session, txn.seller_transaction_id)
      const waiting = [...session.approvals.values()].find((a) => a.type === 'dispute_accept' && a.status === 'pending' && a.disputeId === dispute_id)
      if (waiting) throw new ToolError('A card to settle this claim is already waiting for the shopper. Ask them to approve or reject it.')
      const approval = addApproval(session, { type: 'dispute_accept', orderId: order.orderId, captureId: txn.seller_transaction_id, disputeId: dispute_id, amount: Number(dispute.dispute_amount?.value || 0), reason: note.slice(0, 200), paypalTool: 'accept_dispute_claim' })
      return { approval_id: approval.id, status: 'pending_shopper_approval' }
    },
  },
]

const byName = new Map(TOOLS.map((t) => [t.name, t]))

export function claudeTools() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
}

// Runs a tool and returns { ok, result } without throwing, so the model sees errors as tool results.
export async function runTool(session, name, input) {
  const tool = byName.get(name)
  if (!tool) return { ok: false, source: 'app', result: { error: `Unknown tool ${name}` } }
  try {
    const result = await tool.run(session, input || {})
    if (tool.source !== 'paypal-agent-toolkit') {
      logActivity(session, { source: tool.source, tool: name, origin: 'agent', ok: true })
    }
    return { ok: true, source: tool.source, result }
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Tool failed: ${err.message}`
    if (err instanceof ToolError || tool.source !== 'paypal-agent-toolkit') {
      logActivity(session, { source: tool.source, tool: name, origin: 'agent', ok: false, detail: message })
    }
    return { ok: false, source: tool.source, result: { error: message } }
  }
}
