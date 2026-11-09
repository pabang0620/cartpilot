import { usd } from '../api.js'

const APPROVAL_TITLE = {
  refund: 'Refund',
  dispute_accept: 'Settle dispute',
}

function Approval({ approval, onDecide, busy }) {
  const pending = approval.status === 'pending'
  return (
    <div className={`approval approval--${approval.status}`}>
      <div className="approval__head">
        <strong>{APPROVAL_TITLE[approval.type]} {usd(approval.amount)}</strong>
        <span className="status">{approval.status}</span>
      </div>
      <div className="small muted">Order {approval.orderId}{approval.disputeId ? ` · ${approval.disputeId}` : ''}</div>
      <div className="small">{approval.reason}</div>
      <div className="small muted">Runs PayPal <code>{approval.paypalTool}</code> only after you approve.</div>
      {approval.error && <div className="error small">{approval.error}</div>}
      {approval.result?.refundId && <div className="small">Refund id <code>{approval.result.refundId}</code></div>}
      {pending && (
        <div className="approval__actions">
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide(approval.id, 'reject')}>Reject</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onDecide(approval.id, 'approve')}>
            {approval.type === 'refund' ? 'Approve refund' : 'Approve'}
          </button>
        </div>
      )}
    </div>
  )
}

function Order({ order, onShip, busy }) {
  const refunded = order.refunds.reduce((s, r) => s + Number(r.amount), 0)
  return (
    <div className="order">
      <div className="order__head">
        <strong>{usd(order.total)}</strong>
        <span className={`status status--${order.status}`}>{order.status.replaceAll('_', ' ')}</span>
      </div>
      <div className="small muted">Order <code>{order.orderId}</code></div>
      {order.captureId && <div className="small muted">Capture <code>{order.captureId}</code></div>}
      <ul className="order__items">
        {order.items.map((i) => <li key={i.productId}>{i.quantity} x {i.title}</li>)}
      </ul>
      {order.trackers.map((t) => (
        <div key={t.trackingNumber} className="small">Shipped via {t.carrier} · <code>{t.trackingNumber}</code></div>
      ))}
      {order.refunds.map((r) => (
        <div key={r.refundId} className="small">Refunded {usd(r.amount)} · {r.reason}</div>
      ))}
      {order.disputes.map((d) => (
        <div key={d.disputeId} className="small">Dispute <code>{d.disputeId}</code> · {d.status}</div>
      ))}
      {refunded > 0 && <div className="small"><strong>Net paid {usd(order.total - refunded)}</strong></div>}
      {order.captureId && order.trackers.length === 0 && order.status !== 'REFUNDED' && (
        <button type="button" className="btn btn--ghost small" disabled={busy} onClick={() => onShip(order.orderId)}>
          Seller: simulate shipment
        </button>
      )}
    </div>
  )
}

export default function OrdersPanel({ orders, approvals, busy, onDecide, onShip }) {
  const pending = approvals.filter((a) => a.status === 'pending')
  const done = approvals.filter((a) => a.status !== 'pending').slice(0, 4)
  const visibleOrders = orders.filter((o) => o.captureId).slice().reverse()
  return (
    <section className="panel orders">
      <header className="panel__head">
        <h2>Orders</h2>
        {pending.length > 0 && <span className="badge">{pending.length} to approve</span>}
      </header>
      {pending.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}
      {visibleOrders.length === 0 && <p className="muted empty">No orders yet.</p>}
      {visibleOrders.map((o) => <Order key={o.orderId} order={o} busy={busy} onShip={onShip} />)}
      {done.length > 0 && <h3 className="subhead">Past approvals</h3>}
      {done.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}
    </section>
  )
}
