import { usd } from '../api.js'
import Icon from './Icons.jsx'

const APPROVAL = {
  refund: {
    title: 'Refund request to the merchant',
    button: 'Send refund request',
    how: 'If you approve, the merchant policy checks it and the merchant runs PayPal create_refund on this package.',
  },
  release: {
    title: 'Not delivered: do not charge',
    button: 'Release from hold',
    how: 'If you approve, the merchant releases this package and PayPal voids what is still held. You are never charged for it.',
  },
  dispute_accept: {
    title: 'Ask the merchant to settle the claim',
    button: 'Send to merchant',
    how: 'If you approve, the merchant accepts the claim with PayPal accept_dispute_claim.',
  },
}
const STATUS_TEXT = { approved: 'Approved by you', rejected: 'Rejected by you', failed: 'Failed', expired: 'No longer needed', processing: 'Processing' }

function resultText(approval) {
  if (approval.status !== 'approved' || !approval.result) return null
  if (approval.type === 'refund') return `Merchant policy approved · PayPal refund ${approval.result.refundId}`
  if (approval.type === 'release') return approval.result.status === 'VOIDED' ? `Merchant released it · PayPal authorization ${approval.result.authorizationId} voided` : `Merchant released it · excluded from authorization ${approval.result.authorizationId}`
  return `Merchant settled · dispute ${approval.result.status}`
}

export function Approval({ approval, onDecide, busy }) {
  const meta = APPROVAL[approval.type] || { title: approval.type, button: 'Approve', how: '' }
  if (approval.status === 'pending') {
    return (
      <div className="card approval">
        <div className="approval__k">{meta.title}</div>
        <div className="approval__amt num">{usd(approval.amount)}</div>
        <div>{approval.packageId && <span className="mono">{approval.packageId} · </span>}{approval.reason}</div>
        <div className="muted small">{meta.how}</div>
        <div className="approval__acts">
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide(approval.id, 'reject')}><Icon name="x" />Reject</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onDecide(approval.id, 'approve')}>
            <Icon name="check" />{meta.button}
          </button>
        </div>
      </div>
    )
  }
  const result = resultText(approval)
  return (
    <div className={`past past--${approval.status}`}>
      <span>{meta.title} <b className="num">{usd(approval.amount)}</b></span>
      <span className="past__st">{STATUS_TEXT[approval.status] || approval.status}{approval.decidedAt && ` · ${new Date(approval.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>
      {result && <div className="past__res mono">{result}</div>}
      {approval.error && <div className="past__err">{approval.error}</div>}
    </div>
  )
}

const ORDER_STATUS = {
  AUTHORIZED: 'Held on PayPal',
  PARTIALLY_CAPTURED: 'Charging as packages arrive',
  COMPLETED: 'Settled',
  RELEASED: 'Released, nothing charged',
  PARTIALLY_REFUNDED: 'Partly refunded',
  REFUNDED: 'Refunded',
}

const PACKAGE_STATUS = {
  awaiting_shipment: ['Waiting to ship', 'wait'],
  in_transit: ['In transit · held', 'transit'],
  delivered: ['Delivered · charged', 'paid'],
  released: ['Not delivered · not charged', 'released'],
}

function refundedOn(order, pkg) {
  return order.refunds.filter((r) => r.captureId === pkg.captureId && r.status !== 'FAILED').reduce((s, r) => s + Number(r.amount), 0)
}

export function OrderCard({ order }) {
  const money = order.money || { charged: 0, held: 0, released: 0, refunded: 0 }
  return (
    <div className="card">
      <div className="row"><b>{order.items.map((i) => `${i.quantity} x ${i.title}`).join(', ')}</b><b className="num">{usd(order.total)}</b></div>
      <div className="mono muted">Order {order.orderId} · {ORDER_STATUS[order.status] || order.status}</div>
      <ul className="pkgs">
        {order.packages.map((p) => {
          const [label, tone] = p.lostAt && p.status === 'in_transit' ? ['Carrier: lost · held, not charged', 'lost'] : (PACKAGE_STATUS[p.status] || [p.status, 'wait'])
          const refunded = refundedOn(order, p)
          return (
            <li key={p.id} className="pkg">
              <div className="row">
                <span><b className="mono">{p.id}</b> {p.quantity > 1 ? `${p.quantity} x ` : ''}{p.title}</span>
                <b className="num">{usd(p.amount)}</b>
              </div>
              <div className="row small">
                <span className={`chip chip--${tone}`}>{label}</span>
                {p.trackingNumber && <span className="muted"><Icon name="truck" /> {p.carrier} <span className="mono">{p.trackingNumber}</span></span>}
              </div>
              {refunded > 0 && <div className="row small"><span>Refunded by merchant</span><span className="num">-{usd(refunded)}</span></div>}
            </li>
          )
        })}
      </ul>
      <dl className="ledger num">
        <div><dt>Charged</dt><dd>{usd(money.charged)}</dd></div>
        <div><dt>On hold</dt><dd>{usd(money.held)}</dd></div>
        <div><dt>Never charged</dt><dd>{usd(money.released)}</dd></div>
      </dl>
    </div>
  )
}

// Stands in for the merchant and the carrier in the demo. In production the delivery scan
// comes from the carrier, not from a button.
export function SellerConsole({ order, policy, busy, onShip, onDeliver, onLost, onPlay }) {
  if (!order?.authorizationId) return null
  const waiting = order.packages.filter((p) => p.status === 'awaiting_shipment')
  const transit = order.packages.filter((p) => p.status === 'in_transit' && !p.lostAt)
  return (
    <div className="card seller">
      <div className="seller__k">Demo merchant console</div>
      <p className="muted small">Plays the PayPal Sandbox seller and the carrier. A delivery scan charges that package only.</p>
      {(waiting.length > 0 || transit.length > 1) && (
        <button type="button" className="btn btn--primary seller__play" disabled={busy} onClick={() => onPlay(order.orderId)}>Quick demo: ship, deliver all but one, carrier loses the last</button>
      )}
      <div className="seller__acts">
        {waiting.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => onShip(order.orderId)}><Icon name="truck" />Ship {waiting.length} {waiting.length === 1 ? 'package' : 'packages'}</button>}
        {transit.map((p) => (
          <span key={p.id} className="seller__pkg">
            <button type="button" className="btn" disabled={busy} onClick={() => onDeliver(order.orderId, p.id)}><Icon name="check" />Delivery scan {p.id}</button>
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => onLost(order.orderId, p.id)}>Carrier: lost</button>
          </span>
        ))}
        {waiting.length === 0 && transit.length === 0 && <span className="muted small">All packages are settled.</span>}
      </div>
      {policy?.length > 0 && (
        <details className="seller__policy">
          <summary>Merchant policy</summary>
          <ul>{policy.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
