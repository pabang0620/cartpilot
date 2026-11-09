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
