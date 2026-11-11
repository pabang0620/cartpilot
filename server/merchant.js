import { randomBytes } from 'node:crypto'
import { logActivity } from './store.js'
import { paypal, round2, settleOrderState, packageRefundable, openPackages } from './services.js'
import { HttpError } from './http.js'

// In the demo the app's PayPal Sandbox business account is the merchant. Its rules run here,
// on the merchant side: the shopper's agent only sends requests and never moves money itself.
export const MERCHANT_POLICY = [
  'Each package is charged when it is delivered, not at checkout.',
  'A package is released from the hold, never charged, once the carrier reports it lost or its estimated delivery date has passed. Before that, release requests wait.',
  'Refunds for a delivered package up to its price are approved automatically.',
]

const ETA_DAYS = 2
const locks = new Map()

// Serialize every money move on one order (captures, releases, refunds) so they never interleave.
export function withOrderLock(orderId, fn) {
  const previous = locks.get(orderId) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(orderId, tail)
  tail.then(() => { if (locks.get(orderId) === tail) locks.delete(orderId) })
  return run
}

const trackingNumber = () => `9400${randomBytes(9).toString('hex').replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10)).slice(0, 18)}`
const today = () => new Date().toISOString().slice(0, 10)

function merchantDecision(session, detail, ok = true) {
  logActivity(session, { source: 'merchant', tool: 'merchant_policy', origin: 'merchant-policy', ok, detail })
}

// Why the merchant would (or would not yet) release an undelivered package.
export function releaseEligibility(pkg) {
  if (!['awaiting_shipment', 'in_transit'].includes(pkg.status)) return { ok: false, reason: `${pkg.id} is already ${pkg.status.replaceAll('_', ' ')}.` }
  if (pkg.lostAt) return { ok: true, reason: `carrier reported ${pkg.id} lost` }
  if (pkg.eta && pkg.eta < today()) return { ok: true, reason: `${pkg.id} is past its estimated delivery date ${pkg.eta}` }
  if (pkg.status === 'awaiting_shipment') return { ok: false, reason: `${pkg.id} has not shipped yet. The merchant can cancel it before shipping, but this demo only releases lost or late packages.` }
  return { ok: false, reason: `${pkg.id} is still before its estimated delivery date (${pkg.eta}) and the carrier has not reported it lost. The merchant releases it once either happens.` }
}

export function shipPackages(session, order) {
  const waiting = order.packages.filter((p) => p.status === 'awaiting_shipment')
  if (!waiting.length) throw new HttpError(409, 'Nothing is waiting to ship.')
  const eta = new Date(Date.now() + ETA_DAYS * 86400000).toISOString().slice(0, 10)
  for (const p of waiting) Object.assign(p, { status: 'in_transit', carrier: 'USPS', trackingNumber: trackingNumber(), eta, shippedAt: new Date().toISOString() })
  logActivity(session, { source: 'merchant', tool: 'ship_packages', origin: 'seller', ok: true, detail: `${waiting.length} packages, estimated delivery ${eta}` })
  settleOrderState(session, order)
}

// A delivery scan charges exactly that package: partial capture on the PayPal authorization,
// then the PayPal tracker is added to that capture as DELIVERED. The last open package is the final capture.
export function deliverPackage(session, order, pkg) {
  return withOrderLock(order.orderId, async () => {
    if (pkg.status !== 'in_transit') throw new HttpError(409, `${pkg.id} is ${pkg.status.replaceAll('_', ' ')}.`)
    if (pkg.lostAt) throw new HttpError(409, `${pkg.id} was reported lost by the carrier.`)
    const final = openPackages(order).filter((p) => p !== pkg).length === 0
    const capture = await paypal(session, 'capture_authorization', {
      authorization_id: order.authorizationId,
      amount: pkg.amount,
      final_capture: final,
      invoice_id: `${order.orderId}-${pkg.id}`,
    }, 'delivery-scan')
    Object.assign(pkg, { status: 'delivered', captureId: capture.id, deliveredAt: new Date().toISOString() })
    order.authorizationStatus = final ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
    try {
      await paypal(session, 'create_shipment_tracking', { transaction_id: pkg.captureId, tracking_number: pkg.trackingNumber, status: 'DELIVERED', carrier: pkg.carrier }, 'seller')
    } catch {
      // The charge already happened; a missing PayPal tracker shows as a failed call in the activity log.
    }
    settleOrderState(session, order)
  })
}

export function markLost(session, order, pkg) {
  if (pkg.status !== 'in_transit') throw new HttpError(409, `${pkg.id} is ${pkg.status.replaceAll('_', ' ')}.`)
  pkg.lostAt = new Date().toISOString()
  logActivity(session, { source: 'merchant', tool: 'carrier_reports_lost', origin: 'carrier', ok: true, detail: `${pkg.id} ${pkg.carrier} ${pkg.trackingNumber}` })
  settleOrderState(session, order)
}

// Runs a request the shopper approved. The merchant policy decides; the merchant side calls PayPal.
export function runApproval(session, order, approval) {
  if (!order) throw new HttpError(404, 'Order not found.')
  return withOrderLock(order.orderId, async () => {
    const pkg = order.packages.find((p) => p.id === approval.packageId)
    if (approval.type === 'refund') {
      if (!pkg?.captureId) throw new HttpError(409, 'This package was never charged, so there is nothing to refund.')
      if (approval.amount > packageRefundable(order, pkg)) throw new HttpError(409, 'Refund exceeds what is refundable on this package.')
      merchantDecision(session, `refund $${approval.amount} on delivered ${pkg.id}: within package price, approved`)
      const refund = await paypal(session, 'create_refund', {
        capture_id: pkg.captureId,
        amount: { currency_code: 'USD', value: approval.amount.toFixed(2) },
        note_to_payer: approval.reason,
      }, 'merchant-policy')
      order.refunds.push({ refundId: refund.id, captureId: pkg.captureId, packageId: pkg.id, status: refund.status, amount: approval.amount, reason: approval.reason, createdAt: new Date().toISOString() })
      approval.result = { refundId: refund.id, captureId: pkg.captureId, status: refund.status }
      return
    }
    if (approval.type === 'release') {
      if (!pkg) throw new HttpError(404, 'Package not found.')
      const check = releaseEligibility(pkg)
      if (!check.ok) {
        merchantDecision(session, `release ${pkg.id} not approved yet: ${check.reason}`, false)
        throw new HttpError(409, `Merchant policy: ${check.reason}`)
      }
      merchantDecision(session, `release ${pkg.id}: ${check.reason}, approved`)
      Object.assign(pkg, { status: 'released', releasedAt: new Date().toISOString() })
      if (openPackages(order).length === 0 && !['CAPTURED', 'VOIDED'].includes(order.authorizationStatus)) {
        await paypal(session, 'void_authorization', { authorization_id: order.authorizationId }, 'merchant-policy')
        order.authorizationStatus = 'VOIDED'
        approval.result = { status: 'VOIDED', authorizationId: order.authorizationId }
      } else {
        approval.result = { status: 'RELEASED', authorizationId: order.authorizationId, note: 'Excluded from the hold; the final capture closes the rest' }
      }
      return
    }
    if (approval.type === 'dispute_accept') {
      merchantDecision(session, `accept claim ${approval.disputeId}`)
      await paypal(session, 'accept_dispute_claim', { dispute_id: approval.disputeId, note: approval.reason }, 'merchant-policy')
      const dispute = await paypal(session, 'get_dispute', { dispute_id: approval.disputeId }, 'merchant-policy')
      const local = order.disputes.find((d) => d.disputeId === approval.disputeId)
      if (local) local.status = dispute.status
      else order.disputes.push({ disputeId: approval.disputeId, captureId: approval.captureId, status: dispute.status, reason: dispute.reason, amount: approval.amount })
      const refundId = `dispute-${approval.disputeId}`
      if (!order.refunds.some((r) => r.refundId === refundId)) {
        const refunded = Number(dispute.dispute_outcome?.amount_refunded?.value ?? approval.amount)
        order.refunds.push({ refundId, captureId: approval.captureId, status: 'COMPLETED', amount: refunded, reason: 'Claim settled', createdAt: new Date().toISOString() })
      }
      approval.result = { status: dispute.status }
    }
  })
}

// Demo shortcut for testers: ship everything, deliver all but the last package, the carrier loses the last one.
export async function playMerchantSide(session, order) {
  if (order.packages.some((p) => p.status === 'awaiting_shipment')) shipPackages(session, order)
  const transit = order.packages.filter((p) => p.status === 'in_transit' && !p.lostAt)
  if (!transit.length) throw new HttpError(409, 'Nothing is in transit.')
  const last = transit.length > 1 ? transit[transit.length - 1] : null
  for (const p of transit) {
    if (p !== last) await deliverPackage(session, order, p)
  }
  if (last) markLost(session, order, last)
}

export { round2 }
