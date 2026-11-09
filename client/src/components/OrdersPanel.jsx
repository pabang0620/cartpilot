import { usd } from '../api.js'
import Icon from './Icons.jsx'

const APPROVAL_TITLE = { refund: 'Refund', dispute_accept: 'Settle claim' }
const STATUS_TEXT = { approved: 'Approved by you', rejected: 'Rejected by you', failed: 'Failed', expired: 'No longer needed', processing: 'Processing' }

export function Approval({ approval, onDecide, busy }) {
  if (approval.status === 'pending') {
    return (
      <div className="card approval">
        <div className="approval__k">{APPROVAL_TITLE[approval.type]} waiting for your approval</div>
        <div className="approval__amt num">{usd(approval.amount)}</div>
        <div>{approval.reason}</div>
        <div className="muted small">Runs PayPal <code>{approval.paypalTool}</code> only after you approve.</div>
        <div className="approval__acts">
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide(approval.id, 'reject')}><Icon name="x" />Reject</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onDecide(approval.id, 'approve')}>
            <Icon name="check" />{approval.type === 'refund' ? 'Approve refund' : 'Approve'}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={`past past--${approval.status}`}>
      <span>{APPROVAL_TITLE[approval.type]} <b className="num">{usd(approval.amount)}</b></span>
      <span className="past__st">{STATUS_TEXT[approval.status] || approval.status}</span>
      {approval.error && <div className="past__err">{approval.error}</div>}
    </div>
  )
}

const ORDER_STATUS = { COMPLETED: 'Paid', PARTIALLY_REFUNDED: 'Partly refunded', REFUNDED: 'Refunded' }

export function OrderCard({ order, onShip, busy }) {
  const refunded = order.refunds.reduce((s, r) => s + Number(r.amount), 0)
  return (
    <div className="card">
      <div className="row"><b>{order.items.map((i) => `${i.quantity} x ${i.title}`).join(', ')}</b><b className="num">{usd(order.total)}</b></div>
      <div className="mono muted">Order {order.orderId} · {ORDER_STATUS[order.status] || order.status}</div>
      {order.trackers.map((t) => (
        <div key={t.trackingNumber} className="row track"><Icon name="truck" /><span>{t.carrier} <span className="mono">{t.trackingNumber}</span></span></div>
      ))}
      {order.refunds.map((r) => (
        <div key={r.refundId} className="row small"><span>Refunded · {r.reason}</span><span className="num">-{usd(r.amount)}</span></div>
      ))}
      {order.disputes.map((d) => (
        <div key={d.disputeId} className="row small"><span>Claim <span className="mono">{d.disputeId}</span></span><span>{d.status}</span></div>
      ))}
      {refunded > 0 && <div className="row net"><span>Net paid</span><b className="num">{usd(order.total - refunded)}</b></div>}
      {order.trackers.length === 0 && order.status !== 'REFUNDED' && (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onShip(order.orderId)}>
          Seller demo: mark as shipped
        </button>
      )}
    </div>
  )
}
