import { randomUUID } from 'node:crypto'
import { config, modes } from '../config.js'
import { searchProducts, getProduct, summarizeProduct, bestOffer, offerPrice } from '../integrations/channel3.js'
import { toolkitSchema, mockPaypal } from '../integrations/paypal.js'
import { logActivity, sessionOrders, getSessionOrder, addApproval } from '../store.js'
import { paypal, round2, refundableAmount, captureIds, compactOrder } from '../services.js'

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
      if (session.budget != null) maxPrice = Math.min(maxPrice ?? session.budget, session.budget)
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
      if (session.budget != null && total > session.budget) {
        throw new ToolError(`Cart total $${total} is over the $${session.budget} budget by $${round2(total - session.budget)}. Choose cheaper items or fewer units.`)
      }
      session.cart = { id: randomUUID(), status: 'proposed', items: lines, subtotal, shipping, total, currency: 'USD', summary }
      return { cart_total_usd: total, subtotal_usd: subtotal, shipping_usd: shipping, budget_usd: session.budget, remaining_budget_usd: session.budget != null ? round2(session.budget - total) : null, next_step: 'Shopper reviews the cart and clicks Review & pay.' }
    },
  },
  {
    name: 'list_my_orders',
    source: 'app',
    description: 'List this shopper\'s orders with status, capture id, refunds, tracking and disputes. Call this first for any after-purchase question.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(session) {
      return { orders: sessionOrders(session).map(compactOrder) }
    },
  },
  fromToolkit('get_order', async (session, args) => {
    requireOrder(session, args.id)
    return paypal(session, 'get_order', args)
  }),
  fromToolkit('get_shipment_tracking', async (session, args) => {
    const captures = captureIds(session)
    if (args.order_id) requireOrder(session, args.order_id)
    else if (!captures.has(args.transaction_id)) throw new ToolError('Transaction does not belong to this shopper.')
    return paypal(session, 'get_shipment_tracking', args)
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
    return { items }
  }),
  fromToolkit('get_dispute', async (session, args) => {
    const dispute = await paypal(session, 'get_dispute', args)
    const captures = captureIds(session)
    if (!(dispute.disputed_transactions || []).some((t) => captures.has(t.seller_transaction_id))) {
      throw new ToolError('Dispute does not belong to this shopper.')
    }
    return dispute
  }),
  {
    name: 'request_refund',
    source: 'paypal-agent-toolkit',
    description: 'Prepare a full or partial refund for a paid order. This only creates an approval card; the refund runs through PayPal (create_refund) after the shopper clicks Approve. For a partial refund, compute the amount from item prices in list_my_orders.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        amount_usd: { type: 'number', description: 'Refund amount. Omit for the full refundable amount.' },
        reason: { type: 'string', description: 'Short reason shown to the shopper and sent as note_to_payer.' },
      },
      required: ['order_id', 'reason'],
      additionalProperties: false,
    },
    async run(session, { order_id, amount_usd, reason }) {
      const order = requireOrder(session, order_id)
      if (!order.captureId) throw new ToolError('Order is not paid yet, nothing to refund.')
      const refundable = refundableAmount(order)
      if (refundable <= 0) throw new ToolError('This order is already fully refunded.')
      const pending = round2([...session.approvals.values()]
        .filter((a) => a.type === 'refund' && a.status === 'pending' && a.orderId === order.orderId)
        .reduce((sum, a) => sum + a.amount, 0))
      const available = round2(refundable - pending)
      if (available <= 0) throw new ToolError(`A refund card for $${pending} is already waiting for the shopper. Ask them to approve or reject it first.`)
      const amount = round2(amount_usd ?? available)
      if (!(amount > 0) || amount > available) throw new ToolError(`Refund must be between $0.01 and $${available}${pending ? ` ($${pending} is already waiting in a pending refund card)` : ''}.`)
      const approval = addApproval(session, { type: 'refund', orderId: order.orderId, captureId: order.captureId, amount, reason: reason.slice(0, 200), paypalTool: 'create_refund' })
      return { approval_id: approval.id, status: 'pending_shopper_approval', amount_usd: amount, refundable_usd: refundable }
    },
  },
  {
    name: 'open_claim',
    source: 'app',
    description: 'Draft a PayPal buyer claim (dispute) for a paid order, for an item not received or not as described. In sandbox the shopper submits it in the PayPal Resolution Center; in mock mode it is filed directly. Afterwards use list_disputes to follow it.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        reason: { type: 'string', enum: ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'] },
        amount_usd: { type: 'number', description: 'Disputed amount (usually the affected items).' },
        message: { type: 'string', description: 'Claim message written for the shopper, factual and short.' },
      },
      required: ['order_id', 'reason', 'amount_usd', 'message'],
      additionalProperties: false,
    },
    async run(session, { order_id, reason, amount_usd, message }) {
      const order = requireOrder(session, order_id)
      if (!order.captureId) throw new ToolError('Order is not paid yet.')
      const refundable = refundableAmount(order)
      if (refundable <= 0) throw new ToolError('This order is already fully refunded, there is nothing to claim.')
      const amount = round2(amount_usd)
      if (!(amount > 0) || amount > refundable) throw new ToolError(`Claim amount must be between $0.01 and $${refundable}.`)
      order.claimDraft = { reason, amount, message: message.slice(0, 1000), createdAt: new Date().toISOString() }
      if (modes.paypal === 'mock') {
        const dispute = mockPaypal.openDispute({ captureId: order.captureId, amount, reason, message: order.claimDraft.message })
        order.disputes.push({ disputeId: dispute.dispute_id, status: dispute.status, reason, amount })
        logActivity(session, { source: 'paypal-agent-toolkit', tool: 'buyer_opens_dispute (mock)', origin: 'agent', ok: true })
        return { filed: true, dispute_id: dispute.dispute_id, status: dispute.status }
      }
      return { filed: false, resolution_center_url: SANDBOX_RESOLUTION_CENTER, capture_id: order.captureId, draft: order.claimDraft, next_step: 'Shopper pastes the draft in the PayPal Resolution Center. Then call list_disputes.' }
    },
  },
  {
    name: 'request_dispute_resolution',
    source: 'paypal-agent-toolkit',
    description: 'Resolve an open dispute in the shopper\'s favour by accepting the claim (refund). This only creates an approval card; PayPal accept_dispute_claim runs after the shopper clicks Approve.',
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
      const order = sessionOrders(session).find((o) => o.captureId === txn.seller_transaction_id)
      const approval = addApproval(session, { type: 'dispute_accept', orderId: order.orderId, disputeId: dispute_id, amount: Number(dispute.dispute_amount?.value || 0), reason: note.slice(0, 200), paypalTool: 'accept_dispute_claim' })
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
    if (tool.source !== 'paypal-agent-toolkit' || name.startsWith('request_')) {
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
