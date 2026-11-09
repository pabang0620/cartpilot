import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config, modes } from './config.js'
import { createSession, getSession, getSessionOrder, saveOrder, publicState, logActivity, spentAmount } from './store.js'
import { paypal, round2, refundableAmount, settleOrderState } from './services.js'
import { approvalLink, captureIdOf } from './integrations/paypal.js'
import { runClaudeAgent } from './agent/claudeAgent.js'
import { runMockAgent } from './agent/mockAgent.js'
import { isOutage, degrade, fallbackLog } from './fallback.js'

export const api = Router()

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sessionIdSchema = z.string().uuid()

function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}

function requireSession(id) {
  const session = getSession(id)
  if (!session) throw new HttpError(404, 'Session not found. Reload the page.')
  return session
}

function redirectToApp(res, params) {
  const query = new URLSearchParams(params).toString()
  res.redirect(`${config.appUrl}/?${query}`)
}

api.get('/health', (req, res) => {
  const testBuyer = modes.paypal === 'sandbox' ? config.testBuyer : null
  res.json({ success: true, data: { modes, model: config.anthropicModel, fallbacks: fallbackLog.length, testBuyer } })
})

api.post('/session', (req, res) => {
  const session = createSession()
  res.json({ success: true, data: { ...publicState(session), modes } })
})

api.get('/state', (req, res, next) => {
  try {
    const session = requireSession(parse(sessionIdSchema, req.query.sessionId))
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

api.put('/budget', (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, amount: z.number().positive().max(100000) }), req.body)
    const session = requireSession(body.sessionId)
    if (round2(body.amount) <= 0) throw new HttpError(400, 'amount: must be at least $0.01')
    session.budget = round2(body.amount)
    if (session.cart && session.cart.status !== 'paid' && session.cart.total > round2(session.budget - spentAmount(session))) {
      session.cart = { ...session.cart, overBudget: true }
    } else if (session.cart) {
      session.cart = { ...session.cart, overBudget: false }
    }
    logActivity(session, { source: 'human', tool: 'set_budget', origin: 'shopper', ok: true, detail: `$${session.budget}` })
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

api.post('/chat', async (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, message: z.string().trim().min(1).max(2000) }), req.body)
    const session = requireSession(body.sessionId)
    if (session.busy) throw new HttpError(409, 'The agent is still working on the previous message.')
    session.busy = true
    try {
      let result
      if (modes.llm === 'live' && !req.demoLimited) {
        const before = session.messages?.length ?? 0
        try {
          result = await runClaudeAgent(session, body.message)
        } catch (err) {
          if (!isOutage(err)) throw err
          // Claude is unreachable or the key stopped working: answer from the built-in agent instead.
          if (session.messages) session.messages.length = before
          if (/401|403|authentication|api key|credit balance|permission/i.test(`${err.status} ${err.message}`)) degrade('llm', err)
          console.error('[fallback] Claude call failed, using the built-in agent for this message:', err.message)
          result = await runMockAgent(session, body.message)
        }
      } else {
        result = await runMockAgent(session, body.message)
      }
      const { reply, events } = result
      res.json({ success: true, data: { reply, events, state: publicState(session), modes } })
    } finally {
      session.busy = false
    }
  } catch (err) {
    next(err)
  }
})

// Creates the PayPal order for the reviewed cart. Paying again for the same cart replaces the
// earlier PayPal order, which is voided so it can never be captured.
async function createOrderForCart(session, cart) {
  if (cart.status === 'awaiting_paypal' && cart.orderId) {
    const previous = getSessionOrder(session, cart.orderId)
    if (previous && !previous.captureId) previous.status = 'VOIDED'
  }

  const order = await paypal(session, 'create_order', {
    currencyCode: 'USD',
    items: cart.items.map((i) => ({
      name: i.title.slice(0, 127),
      description: `${i.retailer || 'retailer'} via Channel3`.slice(0, 127),
      quantity: i.quantity,
      itemCost: i.unitPrice,
      taxPercent: 0,
      itemTotal: i.lineTotal,
    })),
    shippingCost: cart.shipping,
    returnUrl: `${config.publicUrl}/api/paypal/return?sid=${session.id}`,
    cancelUrl: `${config.publicUrl}/api/paypal/cancel?sid=${session.id}`,
  }, 'shopper')

  const approveUrl = approvalLink(order)
  if (!approveUrl) throw new HttpError(502, 'PayPal did not return an approval link.')
  saveOrder({
    orderId: order.id,
    sessionId: session.id,
    status: order.status,
    items: cart.items,
    subtotal: cart.subtotal,
    shipping: cart.shipping,
    total: cart.total,
    currency: 'USD',
    captureId: null,
    createdAt: new Date().toISOString(),
    refunds: [],
    trackers: [],
    disputes: [],
  })
  if (!session.orderIds.includes(order.id)) session.orderIds.push(order.id)
  session.cart = { ...cart, status: 'awaiting_paypal', orderId: order.id }
  return { orderId: order.id, approveUrl }
}

// Human step 1: the shopper confirms the summary and asks to pay. Only now an order exists.
api.post('/checkout', async (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, cartId: z.string().uuid() }), req.body)
    const session = requireSession(body.sessionId)
    const cart = session.cart
    if (!cart || cart.id !== body.cartId) throw new HttpError(409, 'Cart changed. Review it again.')
    if (cart.status === 'paid') throw new HttpError(409, 'This cart is already paid.')
    if (session.budget == null) throw new HttpError(400, 'Set a budget cap before paying.')
    const left = round2(session.budget - spentAmount(session))
    if (cart.total > left) throw new HttpError(400, `Cart total $${cart.total} is over the $${left} left in your $${session.budget} cap.`)
    if (session.checkingOut) throw new HttpError(409, 'Checkout is already in progress.')
    session.checkingOut = true
    try {
      const { orderId, approveUrl } = await createOrderForCart(session, cart)
      res.json({ success: true, data: { orderId, approveUrl, state: publicState(session) } })
    } finally {
      session.checkingOut = false
    }
  } catch (err) {
    next(err)
  }
})

// Human step 2: PayPal sends the buyer back after approval. Capture happens only here.
api.get('/paypal/return', async (req, res) => {
  const sid = String(req.query.sid || '')
  const token = String(req.query.token || '')
  const session = getSession(sid)
  const order = session && getSessionOrder(session, token)
  if (!order) return redirectToApp(res, { error: 'Unknown order' })
  if (order.captureId) return redirectToApp(res, { paid: order.orderId })
  // Capture only the order behind the current cart, still inside the budget cap.
  const current = session.cart && session.cart.orderId === order.orderId && session.cart.status === 'awaiting_paypal'
  if (!current || ['CANCELLED', 'VOIDED'].includes(order.status)) {
    order.status = 'VOIDED'
    logActivity(session, { source: 'app', tool: 'refuse_capture', origin: 'paypal-return', ok: false, detail: 'order no longer matches the cart' })
    return redirectToApp(res, { error: 'This PayPal order no longer matches your cart, so it was not charged. Review the cart and pay again.' })
  }
  const left = session.budget == null ? 0 : round2(session.budget - spentAmount(session, order.orderId))
  if (order.total > left) {
    order.status = 'ON_HOLD'
    logActivity(session, { source: 'app', tool: 'refuse_capture', origin: 'paypal-return', ok: false, detail: 'over budget cap' })
    return redirectToApp(res, { error: `Order total $${order.total} is over the $${left} left in your budget cap, so it was not charged. Raise the cap and approve on PayPal again.` })
  }
  try {
    const result = await paypal(session, 'pay_order', { id: order.orderId }, 'paypal-return')
    const captured = result.response || result
    order.captureId = captureIdOf(captured)
    order.status = captured.status || 'COMPLETED'
    if (session.cart && session.cart.orderId === order.orderId) session.cart = { ...session.cart, status: 'paid' }
    redirectToApp(res, { paid: order.orderId })
  } catch (err) {
    order.status = 'PAYER_ACTION_REQUIRED'
    redirectToApp(res, { error: err.message.slice(0, 200) })
  }
})

api.get('/paypal/cancel', (req, res) => {
  const session = getSession(String(req.query.sid || ''))
  const order = session && getSessionOrder(session, String(req.query.token || ''))
  if (order && !order.captureId) {
    order.status = 'CANCELLED'
    if (session.cart && session.cart.orderId === order.orderId) session.cart = { ...session.cart, status: 'proposed', orderId: null }
    logActivity(session, { source: 'human', tool: 'paypal_cancel', origin: 'shopper', ok: true })
  }
  redirectToApp(res, { cancelled: '1' })
})

// Human steps 3 and 4: refund and dispute approvals prepared by the agent.
api.post('/approvals/:id', async (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, decision: z.enum(['approve', 'reject']) }), req.body)
    const session = requireSession(body.sessionId)
    const approval = session.approvals.get(req.params.id)
    if (!approval) throw new HttpError(404, 'Approval not found.')
    if (approval.status !== 'pending') throw new HttpError(409, `Approval already ${approval.status}.`)
    approval.status = 'processing'
    if (body.decision === 'reject') {
      approval.status = 'rejected'
      logActivity(session, { source: 'human', tool: `reject_${approval.type}`, origin: 'shopper', ok: true })
      return res.json({ success: true, data: publicState(session) })
    }
    const order = getSessionOrder(session, approval.orderId)
    try {
      if (approval.type === 'refund') {
        const inFlight = [...session.approvals.values()].filter((a) => a !== approval && a.status === 'processing' && a.orderId === order.orderId).reduce((s, a) => s + a.amount, 0)
        if (approval.amount > round2(refundableAmount(order) - inFlight)) throw new HttpError(409, 'Refund exceeds the refundable amount.')
        const refund = await paypal(session, 'create_refund', {
          capture_id: approval.captureId,
          amount: { currency_code: 'USD', value: approval.amount.toFixed(2) },
          note_to_payer: approval.reason,
        }, 'shopper')
        order.refunds.push({ refundId: refund.id, status: refund.status, amount: approval.amount, reason: approval.reason, createdAt: new Date().toISOString() })
        approval.result = { refundId: refund.id, status: refund.status }
      } else if (approval.type === 'dispute_accept') {
        await paypal(session, 'accept_dispute_claim', { dispute_id: approval.disputeId, note: approval.reason }, 'shopper')
        const dispute = await paypal(session, 'get_dispute', { dispute_id: approval.disputeId }, 'shopper')
        const local = order.disputes.find((d) => d.disputeId === approval.disputeId)
        if (local) local.status = dispute.status
        else order.disputes.push({ disputeId: approval.disputeId, status: dispute.status, reason: dispute.reason, amount: approval.amount })
        const refundId = `dispute-${approval.disputeId}`
        if (!order.refunds.some((r) => r.refundId === refundId)) {
          const refunded = Number(dispute.dispute_outcome?.amount_refunded?.value ?? approval.amount)
          order.refunds.push({ refundId, status: 'COMPLETED', amount: refunded, reason: 'Claim settled', createdAt: new Date().toISOString() })
        }
        approval.result = { status: dispute.status }
      }
      approval.status = 'approved'
    } catch (err) {
      approval.status = 'failed'
      approval.error = err.message
    }
    if (order) settleOrderState(session, order)
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

// Seller-side demo control: the merchant adds tracking after shipping.
api.post('/seller/ship', async (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, orderId: z.string().min(1) }), req.body)
    const session = requireSession(body.sessionId)
    const order = getSessionOrder(session, body.orderId)
    if (!order) throw new HttpError(404, 'Order not found.')
    if (!order.captureId) throw new HttpError(409, 'Order is not paid yet.')
    if (refundableAmount(order) <= 0) throw new HttpError(409, 'Order is fully refunded, nothing to ship.')
    const trackingNumber = `9400${randomBytes(9).toString('hex').replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10)).slice(0, 18)}`
    await paypal(session, 'create_shipment_tracking', {
      transaction_id: order.captureId,
      tracking_number: trackingNumber,
      status: 'SHIPPED',
      carrier: 'USPS',
    }, 'seller')
    order.trackers.push({ trackingNumber, carrier: 'USPS', status: 'SHIPPED', at: new Date().toISOString() })
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

api.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found.' })
})

export function errorHandler(err, req, res, next) {
  const status = err.status || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ success: false, message: status >= 500 ? `Server error: ${err.message}` : err.message })
}
