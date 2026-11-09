import { useEffect, useState } from 'react'
import { usd } from '../api.js'

const STATUS_TEXT = {
  proposed: 'Proposed by the agent. Review before paying.',
  awaiting_paypal: 'Waiting for your approval on PayPal.',
  paid: 'Paid. See Orders.',
}

export default function CartPanel({ budget, spent = 0, cart, onBudget, onReview }) {
  const [value, setValue] = useState(budget ?? '')

  useEffect(() => { setValue(budget ?? '') }, [budget])

  // The cap covers everything spent in this session plus the cart being reviewed.
  const inCart = cart && cart.status !== 'paid' ? cart.total : 0
  const committed = spent + inCart
  const remaining = budget != null && cart ? Math.round((budget - committed) * 100) / 100 : null
  const over = remaining != null && remaining < 0
  const usedPct = budget && cart ? Math.min(100, (committed / budget) * 100) : 0

  return (
    <section className="panel cart">
      <header className="panel__head">
        <h2>Cart</h2>
        {cart && <span className={`status status--${cart.status}`}>{cart.status.replace('_', ' ')}</span>}
      </header>

      <form className="budget" onSubmit={(e) => { e.preventDefault(); const n = Number(value); if (n > 0) onBudget(n) }}>
        <label htmlFor="budget">Budget cap (USD)</label>
        <div className="budget__row">
          <input id="budget" type="number" min="1" step="1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="300" />
          <button className="btn" type="submit">Set</button>
        </div>
        <p className="muted small">The agent can set or lower this cap, never raise it. Payment is blocked above it.</p>
      </form>

      {!cart && <p className="muted empty">No cart yet. Ask the agent for something.</p>}

      {cart && (
        <>
          {cart.summary && <p className="cart__summary">{cart.summary}</p>}
          <ul className="items">
            {cart.items.map((item) => (
              <li key={item.productId} className="item">
                {item.image ? <img src={item.image} alt="" loading="lazy" /> : <div className="item__ph" />}
                <div className="item__body">
                  <a href={item.url} target="_blank" rel="noreferrer" className="item__title">{item.title}</a>
                  <div className="muted small">{item.brand} · {item.retailer}</div>
                  <div className="item__reason">{item.reason}</div>
                </div>
                <div className="item__price">
                  <div>{item.quantity} x {usd(item.unitPrice)}</div>
                  <strong>{usd(item.lineTotal)}</strong>
                </div>
              </li>
            ))}
          </ul>
          <dl className="totals">
            <div><dt>Subtotal</dt><dd>{usd(cart.subtotal)}</dd></div>
            <div><dt>Shipping</dt><dd>{usd(cart.shipping)}</dd></div>
            <div className="totals__total"><dt>Total</dt><dd>{usd(cart.total)}</dd></div>
          </dl>
          {budget != null && (
            <div className="meter" aria-label="Budget used">
              <div className={`meter__bar ${over ? 'meter__bar--over' : ''}`} style={{ width: `${usedPct}%` }} />
              <span className="small">{over ? `Over budget by ${usd(-remaining)}` : `${usd(remaining)} left of ${usd(budget)}`}</span>
            </div>
          )}
          <p className="muted small">{STATUS_TEXT[cart.status]}</p>
          <button
            type="button"
            className="btn btn--paypal btn--block"
            disabled={cart.status === 'paid' || over || budget == null}
            onClick={onReview}
          >
            {budget == null ? 'Set a budget to continue' : cart.status === 'awaiting_paypal' ? 'Resume PayPal approval' : 'Review & pay'}
          </button>
        </>
      )}
    </section>
  )
}
