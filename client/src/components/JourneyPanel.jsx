import { useEffect, useRef } from 'react'
import { usd } from '../api.js'
import Icon from './Icons.jsx'
import CartCard, { BudgetForm } from './CartPanel.jsx'
import { Approval, OrderCard, SellerConsole } from './OrdersPanel.jsx'

const SHORT = ['Find', 'Hold', 'Deliver', 'Fix']

export function journeyInfo(state) {
  const paid = (state.orders || []).filter((o) => o.authorizationId)
  const pending = (state.approvals || []).filter((a) => a.status === 'pending')
  const latest = paid[paid.length - 1]
  const afterSales = (state.approvals || []).length > 0 || paid.some((o) => o.refunds.length || o.disputes.length)
  const openClaims = paid.flatMap((o) => o.disputes.filter((d) => !['RESOLVED', 'CLOSED'].includes(d.status)).map((d) => ({ ...d, orderId: o.orderId })))
  let active = 0
  if (state.budget == null) active = 0
  else if (pending.length || openClaims.length) active = 3
  else if (state.cart && state.cart.status !== 'paid') active = 1 // a new cart restarts at step 2
  else if (afterSales) active = 3
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

function MoneyStrip({ budget, charged, held, released, pending }) {
  const waiting = pending.reduce((s, a) => s + a.amount, 0)
  return (
    <dl className="money money--5 num">
      <div><dt>Cap</dt><dd>{budget == null ? 'Not set' : usd(budget)}</dd></div>
      <div><dt>Charged</dt><dd>{usd(charged || 0)}</dd></div>
      <div><dt>On hold</dt><dd>{usd(held || 0)}</dd></div>
      <div className={released ? 'money--ok' : ''}><dt>Never charged</dt><dd>{usd(released || 0)}</dd></div>
      <div className={pending.length ? 'money--wait' : ''}><dt>Waits for you</dt><dd>{pending.length ? usd(waiting) : '-'}</dd></div>
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

export default function JourneyPanel({ state, busy, policy, onBudget, onReview, onDecide, onShip, onDeliver, onLost, onPlay }) {
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
  const held = paid.reduce((s, o) => s + (o.money?.held || 0), 0)
  const released = paid.reduce((s, o) => s + (o.money?.released || 0), 0)
  const refunded = paid.reduce((s, o) => s + (o.money?.refunded || 0), 0)
  const settled = paid.length > 0 && held === 0 && pending.length === 0
  const delivered = latest ? latest.packages.filter((p) => p.status === 'delivered').length : 0
  const shipSummary = latest ? `${delivered} of ${latest.packages.length} packages delivered · charged ${usd(latest.money?.charged || 0)}` : null
  return (
    <aside className="journey" aria-label="This purchase" ref={panelRef}>
      <div className="journey__h">
        <h2>This purchase</h2>
        <p>PayPal holds the money. Each package is charged when it is delivered.</p>
      </div>
      <MoneyStrip budget={state.budget} charged={state.charged} held={held} released={released} pending={pending} />

      <Step index={0} active={active} title="Find" aside="Channel3 catalog" summary={state.budget != null ? `Budget cap ${usd(state.budget)}` : null}>
        <div className="card"><BudgetForm budget={state.budget} onBudget={onBudget} /></div>
      </Step>

      <div id="pay" />
      <Step index={1} active={active} title="Cart and hold" aside="PayPal authorization" summary={cart?.status === 'paid' ? `Held ${cartSummary}` : cartSummary}>
        {state.cart
          ? <CartCard budget={state.budget} spent={state.spent || 0} cart={state.cart} onReview={onReview} />
          : <p className="step__empty">The agent puts its picks here. You approve a PayPal hold; nothing is charged at checkout.</p>}
      </Step>

      <Step index={2} active={active} title="Deliver and charge" aside="Capture per package" summary={shipSummary}>
        {latest
          ? <><OrderCard order={latest} /><SellerConsole order={latest} policy={policy} busy={busy} onShip={onShip} onDeliver={onDeliver} onLost={onLost} onPlay={onPlay} /></>
          : <p className="step__empty">After you approve on PayPal, each package shows here. It is charged on its delivery scan.</p>}
        {earlier.length > 0 && (
          <details className="earlier">
            <summary>{earlier.length} earlier {earlier.length === 1 ? 'order' : 'orders'}</summary>
            {earlier.map((o) => <div key={o.orderId}><OrderCard order={o} /><SellerConsole order={o} policy={policy} busy={busy} onShip={onShip} onDeliver={onDeliver} onLost={onLost} onPlay={onPlay} /></div>)}
          </details>
        )}
      </Step>

      <div id="fix">
        <Step index={3} active={active} title="Fix" aside={pending.length ? 'Needs you' : 'Merchant first, no chargebacks'}>
          {settled && (
            <div className="card settled">
              <div className="approval__k">Settled</div>
              <div className="row"><span>Charged</span><b className="num">{usd(state.charged)}</b></div>
              <div className="row"><span>Refunded by the merchant</span><b className="num">{usd(refunded)}</b></div>
              <div className="row"><span>Never charged</span><b className="num">{usd(released)}</b></div>
              <div className="muted small">You paid only for what arrived intact. Ask the agent for replacements inside your cap.</div>
            </div>
          )}
          {pending.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}
          {openClaims.map((d) => (
            <div key={d.disputeId} className="card claim">
              <div className="row"><b>Claim open</b><b className="num">{usd(d.amount)}</b></div>
              <div className="mono muted">{d.disputeId} · {d.status.replaceAll('_', ' ')}</div>
              <div className="muted small">Ask the agent to settle it. Settling waits for your approval here.</div>
            </div>
          ))}
          {pending.length === 0 && openClaims.length === 0 && past.length === 0 && (
            <p className="step__empty">Damaged or missing? Tell the agent. It prepares a request to the merchant and you approve it here.</p>
          )}
          {past.length > 0 && <div className="pastlist">{past.map((a) => <Approval key={a.id} approval={a} busy={busy} onDecide={onDecide} />)}</div>}
        </Step>
      </div>
    </aside>
  )
}
