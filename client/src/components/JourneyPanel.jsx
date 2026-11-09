import { useEffect, useRef } from 'react'
import { usd } from '../api.js'
import Icon from './Icons.jsx'
import CartCard, { BudgetForm } from './CartPanel.jsx'
import { Approval, OrderCard } from './OrdersPanel.jsx'

const STEPS = ['Find', 'Cart and pay', 'Shipped', 'Fix']
const SHORT = ['Find', 'Pay', 'Ship', 'Fix']

export function journeyInfo(state) {
  const paid = (state.orders || []).filter((o) => o.captureId)
  const pending = (state.approvals || []).filter((a) => a.status === 'pending')
  const latest = paid[paid.length - 1]
  const afterSales = (state.approvals || []).length > 0 || paid.some((o) => o.refunds.length || o.disputes.length)
  const openClaims = paid.flatMap((o) => o.disputes.filter((d) => !['RESOLVED', 'CLOSED'].includes(d.status)).map((d) => ({ ...d, orderId: o.orderId })))
  let active = 0
  if (state.budget == null) active = 0
  else if (pending.length || openClaims.length) active = 3
  else if (state.cart && state.cart.status !== 'paid') active = 1 // a new cart restarts at step 2
  else if (afterSales || latest?.trackers.length) active = 3
  else if (latest) active = 2
  return { paid, pending, openClaims, active }
}

// Finished steps fold into one line so the step that needs the shopper stays in view.
function Step({ index, active, title, aside, summary, children }) {
  const phase = index < active ? 'done' : index === active ? 'now' : 'todo'
  const folded = phase === 'done' && summary
  return (
    <div className={`step step--${phase}`} aria-current={phase === 'now' ? 'step' : undefined}>
      <div className="step__mark">{phase === 'done' ? <Icon name="check" /> : index + 1}</div>
      <div className="step__body">
        <div className="step__h"><b>{title}</b>{aside && <span>{aside}</span>}</div>
        {folded ? (
          <details className="fold">
            <summary><span className="fold__t">{summary}</span><span className="fold__more">Details</span></summary>
            {children}
          </details>
        ) : children}
      </div>
    </div>
  )
}

function MoneyStrip({ budget, spent, pending }) {
  const waiting = pending.reduce((s, a) => s + a.amount, 0)
  return (
    <dl className="money num">
      <div><dt>Cap</dt><dd>{budget == null ? 'Not set' : usd(budget)}</dd></div>
      <div><dt>Net paid</dt><dd>{usd(spent || 0)}</dd></div>
      <div className={pending.length ? 'money--wait' : ''}><dt>Waits for you</dt><dd>{pending.length ? usd(waiting) : 'Nothing'}</dd></div>
    </dl>
  )
}

export function MiniSteps({ state }) {
  const { pending, active } = journeyInfo(state)
  const payable = state.cart && state.cart.status !== 'paid' && !pending.length
  return (
    <div className="ministeps">
      <div className="ministeps__row">
        {SHORT.map((s, i) => <div key={s} className={i < active ? 'done' : i === active ? 'now' : ''}>{i + 1} {s}</div>)}
      </div>
      {pending.length > 0 && <a className="ministeps__wait" href="#fix">{pending.length} {pending.length === 1 ? 'approval waits' : 'approvals wait'} for you</a>}
      {payable && <a className="ministeps__wait" href="#pay">Cart ready: {usd(state.cart.total)}. Review and pay</a>}
    </div>
  )
}

export default function JourneyPanel({ state, busy, onBudget, onReview, onDecide, onShip }) {
  const { paid, pending, openClaims, active } = journeyInfo(state)
  const latest = paid[paid.length - 1]
  const earlier = paid.slice(0, -1).reverse()
  const past = (state.approvals || []).filter((a) => a.status !== 'pending').slice(0, 4)
  const panelRef = useRef(null)
  const seen = useRef(0)

  // Bring a newly prepared approval card into view.
  useEffect(() => {
    if (pending.length > seen.current) document.getElementById('fix')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    seen.current = pending.length
  }, [pending.length])

  const cart = state.cart
  const cartSummary = cart ? `${usd(cart.total)} · ${cart.items.map((i) => `${i.quantity} x ${i.title}`).join(', ')}` : null
  const shipSummary = latest?.trackers.length ? `${latest.trackers[0].carrier} ${latest.trackers[0].trackingNumber}` : latest ? `Order ${latest.orderId} paid` : null
  return (
    <aside className="journey" aria-label="This purchase" ref={panelRef}>
      <div className="journey__h">
        <h2>This purchase</h2>
        <p>Every money move waits for your click.</p>
      </div>
      <MoneyStrip budget={state.budget} spent={state.spent} pending={pending} />

      <Step index={0} active={active} title="Find" aside="Channel3 catalog" summary={state.budget != null ? `Budget cap ${usd(state.budget)}` : null}>
        <div className="card"><BudgetForm budget={state.budget} onBudget={onBudget} /></div>
      </Step>

      <div id="pay" />
      <Step index={1} active={active} title="Cart and pay" aside="PayPal checkout" summary={cart?.status === 'paid' ? `Paid ${cartSummary}` : cartSummary}>
        {state.cart
          ? <CartCard budget={state.budget} spent={state.spent || 0} cart={state.cart} onReview={onReview} />
          : <p className="step__empty">The agent puts its picks here. Nothing is charged until you approve on PayPal.</p>}
      </Step>

      <Step index={2} active={active} title="Shipped" aside="PayPal tracking" summary={shipSummary}>
        {latest
          ? <OrderCard order={latest} busy={busy} onShip={onShip} />
          : <p className="step__empty">After you pay, the order and its tracking number show here.</p>}
        {earlier.length > 0 && (
          <details className="earlier">
            <summary>{earlier.length} earlier {earlier.length === 1 ? 'order' : 'orders'}</summary>
            {earlier.map((o) => <OrderCard key={o.orderId} order={o} busy={busy} onShip={onShip} />)}
          </details>
        )}
      </Step>

      <div id="fix">
        <Step index={3} active={active} title="Fix" aside={pending.length ? 'Needs you' : 'Refunds and claims'}>
          {pending.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}
          {openClaims.map((d) => (
            <div key={d.disputeId} className="card claim">
              <div className="row"><b>Claim open</b><b className="num">{usd(d.amount)}</b></div>
              <div className="mono muted">{d.disputeId} · {d.status.replaceAll('_', ' ')}</div>
              <div className="muted small">Ask the agent to settle it. Settling waits for your approval here.</div>
            </div>
          ))}
          {pending.length === 0 && openClaims.length === 0 && past.length === 0 && (
            <p className="step__empty">Ask for a refund or a claim in the chat. The agent drafts it and you approve it here.</p>
          )}
          {past.length > 0 && <div className="pastlist">{past.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}</div>}
        </Step>
      </div>
    </aside>
  )
}
