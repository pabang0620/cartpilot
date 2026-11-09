import { callPaypal } from './integrations/paypal.js'
import { logActivity, sessionOrders } from './store.js'

export const round2 = (n) => Math.round(n * 100) / 100

// Every PayPal call goes through the Agent Toolkit (or its mock) and is logged for the UI.
export async function paypal(session, name, args, origin = 'agent') {
  try {
    const result = await callPaypal(name, args)
    logActivity(session, { source: 'paypal-agent-toolkit', tool: name, origin, ok: true })
    return result
  } catch (err) {
    logActivity(session, { source: 'paypal-agent-toolkit', tool: name, origin, ok: false, detail: err.message })
    throw err
  }
}

export function refundedAmount(order) {
  return round2(order.refunds.filter((r) => r.status !== 'FAILED').reduce((s, r) => s + Number(r.amount), 0))
}

export function refundableAmount(order) {
  return round2(order.total - refundedAmount(order))
}

const CLOSED_DISPUTE = new Set(['RESOLVED', 'CLOSED'])

// Money already promised on an order but not refunded yet: pending refund cards and open claims.
export function reservedAmount(session, order) {
  const pendingRefunds = [...session.approvals.values()]
    .filter((a) => a.type === 'refund' && a.status === 'pending' && a.orderId === order.orderId)
    .reduce((s, a) => s + a.amount, 0)
  const openClaims = order.disputes.filter((d) => !CLOSED_DISPUTE.has(d.status)).reduce((s, d) => s + Number(d.amount || 0), 0)
  return { pendingRefunds: round2(pendingRefunds), openClaims: round2(openClaims), total: round2(pendingRefunds + openClaims) }
}

// After money moves: show REFUNDED states and retire approval cards that can no longer succeed.
export function settleOrderState(session, order) {
  const refundable = refundableAmount(order)
  if (order.captureId && order.refunds.some((r) => r.status !== 'FAILED')) {
    order.status = refundable <= 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  }
  for (const card of session.approvals.values()) {
    if (card.status !== 'pending' || card.orderId !== order.orderId) continue
    if (card.amount > refundable) {
      card.status = 'expired'
      card.error = refundable <= 0 ? 'Order is already fully refunded.' : `Only $${refundable} is still refundable.`
    }
  }
}

export function captureIds(session) {
  return new Set(sessionOrders(session).map((o) => o.captureId).filter(Boolean))
}

export function compactOrder(order) {
  return {
    order_id: order.orderId,
    status: order.status,
    capture_id: order.captureId,
    total_usd: order.total,
    refunded_usd: refundedAmount(order),
    refundable_usd: refundableAmount(order),
    items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, unit_price_usd: i.unitPrice })),
    tracking: order.trackers,
    disputes: order.disputes.map((d) => ({ dispute_id: d.disputeId, status: d.status, reason: d.reason })),
    claim_draft: order.claimDraft || null,
    created_at: order.createdAt,
  }
}
