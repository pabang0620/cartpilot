import { useEffect, useState } from 'react'
import { usd } from '../api.js'
import Icon from './Icons.jsx'

export function BudgetForm({ budget, onBudget }) {
  const [value, setValue] = useState(budget ?? '')
  useEffect(() => { setValue(budget ?? '') }, [budget])
  return (
    <form className="budget" onSubmit={(e) => { e.preventDefault(); const n = Number(value); if (n >= 0.01 && n <= 100000) onBudget(n) }}>
      <label htmlFor="budget">Budget cap</label>
      <div className="budget__row">
        <span className="budget__unit">USD</span>
        <input id="budget" type="number" min="1" max="100000" step="1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="300" />
        <button className="btn" type="submit">Set</button>
      </div>
      <p className="note"><Icon name="lock" />The agent can lower this cap, never raise it.</p>
    </form>
  )
}

export function BudgetMeter({ budget, spent, cart }) {
  if (budget == null) return null
  // The cap covers everything paid in this session plus the cart under review.
  const inCart = cart && cart.status !== 'paid' ? cart.total : 0
  const committed = Math.round((spent + inCart) * 100) / 100
  const remaining = Math.round((budget - committed) * 100) / 100
  const over = remaining < 0
  const pct = Math.min(100, (committed / budget) * 100)
  return (
    <div className={`meter ${over ? 'meter--over' : ''}`} aria-label="Budget used">
      <div className="meter__bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="meter__lbl num">
        <span>{usd(committed)} of {usd(budget)}</span>
        <span>{over ? `Over by ${usd(-remaining)}` : `${usd(remaining)} left`}</span>
      </div>
    </div>
  )
}

export default function CartCard({ budget, spent = 0, cart, onReview }) {
  if (!cart) return null
  const left = budget != null ? Math.round((budget - spent) * 100) / 100 : null
  const over = left != null && cart.status !== 'paid' && cart.total > left
  return (
    <div className="card">
      {cart.summary && <p className="cart__summary">{cart.summary}</p>}
      <ul className="items">
        {cart.items.map((item) => (
          <li key={item.productId} className="item">
            {item.image ? <img src={item.image} alt="" loading="lazy" /> : <div className="item__ph"><Icon name="box" /></div>}
            <div className="item__body">
              <a href={item.url} target="_blank" rel="noreferrer" className="item__title">{item.title}</a>
              <div className="muted small">{item.brand} · {item.quantity} x {usd(item.unitPrice)}</div>
              {item.reason && <div className="item__reason">{item.reason}</div>}
            </div>
            <b className="num">{usd(item.lineTotal)}</b>
          </li>
        ))}
      </ul>
      <dl className="totals num">
        <div><dt>Subtotal</dt><dd>{usd(cart.subtotal)}</dd></div>
        <div><dt>Shipping</dt><dd>{usd(cart.shipping)}</dd></div>
        <div className="totals__total"><dt>Total</dt><dd>{usd(cart.total)}</dd></div>
      </dl>
      <BudgetMeter budget={budget} spent={spent} cart={cart} />
      {cart.status === 'paid' ? (
        <div className="row approved-line"><span><Icon name="check" />Approved by you on <span className="pp">PayPal</span></span></div>
      ) : (
        <button type="button" className="btn btn--paypal btn--block" disabled={over || budget == null} onClick={onReview}>
          {budget == null ? 'Set a budget to continue'
            : over ? `Over your cap by ${usd(Math.round((cart.total - left) * 100) / 100)}`
              : cart.status === 'awaiting_paypal' ? 'Resume PayPal approval' : `Review & pay ${usd(cart.total)}`}
        </button>
      )}
    </div>
  )
}
