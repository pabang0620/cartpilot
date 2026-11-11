import { z } from 'zod'
import { config } from './config.js'
import { getSession, getSessionOrder, saveOrder, publicState, logActivity, spentAmount } from './store.js'
import { paypal, round2, settleOrderState } from './services.js'
import { shipPackages, deliverPackage, markLost, runApproval, playMerchantSide } from './merchant.js'
export { MERCHANT_POLICY } from './merchant.js'
import { approvalLink, authorizationOf } from './integrations/paypal.js'
import { HttpError, sessionIdSchema, parse, requireSession, redirectToApp } from './http.js'

const MAX_PACKAGES = 12

// One package per unit (so each unit is charged on its own delivery), grouped per line for big carts.
function buildPackages(order) {
  const units = order.items.reduce((s, i) => s + i.quantity, 0)
  const perUnit = units <= MAX_PACKAGES
  const packages = []
  for (const item of order.items) {
    const count = perUnit ? item.quantity : 1
    for (let k = 0; k < count; k += 1) {
      const quantity = perUnit ? 1 : item.quantity
      packages.push({
        id: `PKG-${packages.length + 1}`,
        title: item.title,
        quantity,
        amount: round2(item.unitPrice * quantity),
        status: 'awaiting_shipment',
        carrier: null,
        trackingNumber: null,
        eta: null,
        shippedAt: null,
        deliveredAt: null,
        captureId: null,
      })
    }
  }
  if (order.shipping > 0 && packages.length) packages[0].amount = round2(packages[0].amount + order.shipping)
  return packages
}

// Creates the PayPal order for the reviewed cart. Paying again for the same cart replaces the
// earlier PayPal order, which is voided so it can never be authorized.
async function createOrderForCart(session, cart) {
  if (cart.status === 'awaiting_paypal' && cart.orderId) {
    const previous = getSessionOrder(session, cart.orderId)
    if (previous && !previous.authorizationId) previous.status = 'VOIDED'
  }

  const order = await paypal(session, 'create_authorize_order', {
    items: cart.items.map((i) => ({
      name: i.title.slice(0, 127),
      description: `${i.retailer || 'retailer'} via Channel3`.slice(0, 127),
      quantity: i.quantity,
      itemCost: i.unitPrice,
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
    authorizationId: null,
    authorizationStatus: null,
    packages: [],
    createdAt: new Date().toISOString(),
    refunds: [],
    disputes: [],
  })
  if (!session.orderIds.includes(order.id)) session.orderIds.push(order.id)
  session.cart = { ...cart, status: 'awaiting_paypal', orderId: order.id }
  return { orderId: order.id, approveUrl }
}

function refuseApproval(session, order, detail, message) {
  logActivity(session, { source: 'app', tool: 'refuse_authorization', origin: 'paypal-return', ok: false, detail })
  return message
}

export function registerPaymentRoutes(api) {
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

  // Human step 2: PayPal sends the buyer back after approval. The money is authorized (held), not charged.
  api.get('/paypal/return', async (req, res) => {
    const session = getSession(String(req.query.sid || ''))
    const order = session && getSessionOrder(session, String(req.query.token || ''))
    if (!order) return redirectToApp(res, { error: 'Unknown order' })
    if (order.authorizationId) return redirectToApp(res, { paid: order.orderId })
    if (order.authorizing) return redirectToApp(res, { paid: order.orderId })
    // Authorize only the order behind the current cart, still inside the budget cap.
    const current = session.cart && session.cart.orderId === order.orderId && session.cart.status === 'awaiting_paypal'
    if (!current || ['CANCELLED', 'VOIDED'].includes(order.status)) {
      order.status = 'VOIDED'
      return redirectToApp(res, { error: refuseApproval(session, order, 'order no longer matches the cart', 'This PayPal order no longer matches your cart, so nothing was held or charged. Review the cart and pay again.') })
    }
    const left = session.budget == null ? 0 : round2(session.budget - spentAmount(session, order.orderId))
    if (order.total > left) {
      order.status = 'ON_HOLD'
      return redirectToApp(res, { error: refuseApproval(session, order, 'over budget cap', `Order total $${order.total} is over the $${left} left in your budget cap, so nothing was held or charged. Raise the cap and approve on PayPal again.`) })
    }
    order.authorizing = true
    try {
      const result = await paypal(session, 'authorize_order', { id: order.orderId }, 'paypal-return')
      const authorization = authorizationOf(result)
      if (!authorization) throw new Error('PayPal did not return an authorization.')
      order.authorizationId = authorization.id
      order.authorizationStatus = authorization.status
      order.status = 'AUTHORIZED'
      order.packages = buildPackages(order)
      if (session.cart && session.cart.orderId === order.orderId) session.cart = { ...session.cart, status: 'paid' }
      redirectToApp(res, { paid: order.orderId })
    } catch (err) {
      order.status = 'PAYER_ACTION_REQUIRED'
      redirectToApp(res, { error: err.message.slice(0, 200) })
    } finally {
      order.authorizing = false
    }
  })

  api.get('/paypal/cancel', (req, res) => {
    const session = getSession(String(req.query.sid || ''))
    const order = session && getSessionOrder(session, String(req.query.token || ''))
    if (order && !order.authorizationId) {
      order.status = 'CANCELLED'
      if (session.cart && session.cart.orderId === order.orderId) session.cart = { ...session.cart, status: 'proposed', orderId: null }
      logActivity(session, { source: 'human', tool: 'paypal_cancel', origin: 'shopper', ok: true })
    }
    redirectToApp(res, { cancelled: '1' })
  })

  // Human steps 3 and 4: requests prepared by the agent. The shopper approves sending them;
  // the merchant policy decides and the merchant side runs the PayPal call.
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
      logActivity(session, { source: 'human', tool: `approve_${approval.type}`, origin: 'shopper', ok: true })
      const order = getSessionOrder(session, approval.orderId)
      try {
        await runApproval(session, order, approval)
        approval.status = 'approved'
        approval.decidedAt = new Date().toISOString()
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

  // Merchant and carrier side (demo merchant console).
  const sellerRoute = (path, extra, action) => api.post(path, async (req, res, next) => {
    try {
      const body = parse(z.object({ sessionId: sessionIdSchema, orderId: z.string().min(1), ...extra }), req.body)
      const session = requireSession(body.sessionId)
      const order = getSessionOrder(session, body.orderId)
      if (!order) throw new HttpError(404, 'Order not found.')
      if (!order.authorizationId) throw new HttpError(409, 'Order is not approved on PayPal yet.')
      let pkg = null
      if (body.packageId) {
        pkg = order.packages.find((p) => p.id === body.packageId)
        if (!pkg) throw new HttpError(404, 'Package not found.')
      }
      await action(session, order, pkg)
      res.json({ success: true, data: publicState(session) })
    } catch (err) {
      next(err)
    }
  })
  const packageId = { packageId: z.string().min(1) }
  sellerRoute('/seller/ship', {}, (session, order) => shipPackages(session, order))
  sellerRoute('/seller/deliver', packageId, (session, order, pkg) => deliverPackage(session, order, pkg))
  sellerRoute('/seller/lost', packageId, (session, order, pkg) => markLost(session, order, pkg))
  sellerRoute('/seller/play', {}, (session, order) => playMerchantSide(session, order))
}
