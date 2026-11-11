import { callPaypal, REST_CALLS } from './integrations/paypal.js'
import { logActivity, sessionOrders } from './store.js'

export const round2 = (n) => Math.round(n * 100) / 100

// Every PayPal call is logged for the UI with where it ran: the Agent Toolkit, or the
// Orders/Payments REST API for the authorize-and-capture-on-delivery flow.
export async function paypal(session, name, args, origin = 'agent') {
  const source = REST_CALLS.has(name) ? 'paypal-rest' : 'paypal-agent-toolkit'
  try {
    const result = await callPaypal(name, args)
    logActivity(session, { source, tool: name, origin, ok: true })
    return result
  } catch (err) {
    logActivity(session, { source, tool: name, origin, ok: false, detail: err.message })
    throw err
  }
}

const sum = (list, pick) => round2(list.reduce((s, x) => s + Number(pick(x) || 0), 0))
const OPEN_PACKAGE = new Set(['awaiting_shipment', 'in_transit'])

export function refundedAmount(order) {
  return sum(order.refunds.filter((r) => r.status !== 'FAILED'), (r) => r.amount)
}

export function capturedAmount(order) {
  return sum(order.packages || [], (p) => (p.captureId ? p.amount : 0))
}

// Still held on the PayPal authorization: packages not delivered yet and not released.
export function heldAmount(order) {
  if (!order.authorizationId || order.authorizationStatus === 'VOIDED') return 0
  return sum((order.packages || []).filter((p) => OPEN_PACKAGE.has(p.status)), (p) => p.amount)
}

export function releasedAmount(order) {
  return sum((order.packages || []).filter((p) => p.status === 'released'), (p) => p.amount)
}

// Money the shopper has actually paid on this order (captured minus refunded).
export function chargedAmount(order) {
  return round2(capturedAmount(order) - refundedAmount(order))
}

export function refundableAmount(order) {
  return chargedAmount(order)
}

export function packageRefunded(order, pkg) {
  return sum(order.refunds.filter((r) => r.status !== 'FAILED' && r.captureId === pkg.captureId), (r) => r.amount)
}

export function packageRefundable(order, pkg) {
  return pkg.captureId ? round2(pkg.amount - packageRefunded(order, pkg)) : 0
}

export function openPackages(order) {
  return (order.packages || []).filter((p) => OPEN_PACKAGE.has(p.status))
}

export function orderMoney(order) {
  return { charged: chargedAmount(order), held: heldAmount(order), released: releasedAmount(order), refunded: refundedAmount(order) }
}

const CLOSED_DISPUTE = new Set(['RESOLVED', 'CLOSED'])

// Money already promised on an order but not refunded yet: pending refund cards and open claims.
export function reservedAmount(session, order, captureId = null) {
  const pendingRefunds = [...session.approvals.values()]
    .filter((a) => a.type === 'refund' && (a.status === 'pending' || a.status === 'processing') && a.orderId === order.orderId && (!captureId || a.captureId === captureId))
    .reduce((s, a) => s + a.amount, 0)
  const openClaims = order.disputes.filter((d) => !CLOSED_DISPUTE.has(d.status) && (!captureId || d.captureId === captureId)).reduce((s, d) => s + Number(d.amount || 0), 0)
  return { pendingRefunds: round2(pendingRefunds), openClaims: round2(openClaims), total: round2(pendingRefunds + openClaims) }
}

// After money moves: show the order state and retire approval cards that can no longer succeed.
export function settleOrderState(session, order) {
  const packages = order.packages || []
  if (order.authorizationId) {
    const allClosed = packages.every((p) => !OPEN_PACKAGE.has(p.status))
    const refunded = refundedAmount(order)
    // While anything is still on hold, the order is in delivery, whatever was refunded so far.
    if (!allClosed) order.status = capturedAmount(order) > 0 ? 'PARTIALLY_CAPTURED' : 'AUTHORIZED'
    else if (refunded > 0) order.status = chargedAmount(order) <= 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    else order.status = capturedAmount(order) > 0 ? 'COMPLETED' : 'RELEASED'
  }
  for (const card of session.approvals.values()) {
    if (card.status !== 'pending' || card.orderId !== order.orderId) continue
    const pkg = packages.find((p) => p.id === card.packageId)
    if (card.type === 'refund' && pkg) {
      const left = packageRefundable(order, pkg)
      if (card.amount > left) {
        card.status = 'expired'
        card.error = left <= 0 ? 'This package is already fully refunded.' : `Only $${left} is still refundable on this package.`
      }
    }
    if (card.type === 'release' && pkg && !OPEN_PACKAGE.has(pkg.status)) {
      card.status = 'expired'
      card.error = pkg.status === 'delivered' ? 'The package was delivered and charged, so there is nothing to release.' : 'This package is already settled.'
    }
  }
}

export function captureIds(session) {
  return new Set(sessionOrders(session).flatMap((o) => (o.packages || []).map((p) => p.captureId)).filter(Boolean))
}

export function orderByCapture(session, captureId) {
  return sessionOrders(session).find((o) => (o.packages || []).some((p) => p.captureId === captureId)) || null
}

// Mirror PayPal disputes onto the shopper's orders (sandbox disputes are opened outside the app).
export function syncDisputes(session, disputes) {
  for (const d of disputes) {
    const txn = (d.disputed_transactions || []).find((t) => orderByCapture(session, t.seller_transaction_id))
    if (!txn) continue
    const order = orderByCapture(session, txn.seller_transaction_id)
    const amount = Number(d.dispute_amount?.value ?? txn.seller_transaction_amount?.value ?? 0)
    const local = order.disputes.find((x) => x.disputeId === d.dispute_id)
    if (local) {
      local.status = d.status || local.status
      if (!local.amount && amount) local.amount = amount
    } else {
      order.disputes.push({ disputeId: d.dispute_id, captureId: txn.seller_transaction_id, status: d.status, reason: d.reason, amount })
    }
  }
}

export function compactOrder(order) {
  const money = orderMoney(order)
  return {
    order_id: order.orderId,
    status: order.status,
    authorization_id: order.authorizationId,
    total_authorized_usd: order.total,
    charged_usd: money.charged,
    on_hold_usd: money.held,
    released_usd: money.released,
    refunded_usd: money.refunded,
    packages: (order.packages || []).map((p) => ({
      package_id: p.id,
      item: p.title,
      price_usd: p.amount,
      status: p.status,
      carrier_reported_lost: !!p.lostAt,
      carrier: p.carrier,
      tracking_number: p.trackingNumber,
      estimated_delivery: p.eta,
      delivered_at: p.deliveredAt,
      capture_id: p.captureId,
      refundable_usd: packageRefundable(order, p),
    })),
    disputes: order.disputes.map((d) => ({ dispute_id: d.disputeId, status: d.status, reason: d.reason })),
    claim_draft: order.claimDraft || null,
    created_at: order.createdAt,
  }
}
