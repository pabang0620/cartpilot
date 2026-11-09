import { useEffect, useRef, useState } from 'react'
import { usd } from '../api.js'

function Copy({ value }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="copy" onClick={() => { navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => {}) }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

export default function CheckoutModal({ cart, budget, paypalMode, testBuyer, busy, error, onConfirm, onClose }) {
  const cardRef = useRef(null)
  const payRef = useRef(null)

  useEffect(() => {
    const opener = document.activeElement
    payRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !cardRef.current) return
      const items = [...cardRef.current.querySelectorAll('button:not([disabled])')]
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.() }
  }, [onClose])

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title" onClick={onClose}>
      <div className="modal__card" ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <h2 id="checkout-title">Confirm before paying</h2>
        <p className="muted">The agent built this cart. You are the one who pays.</p>
        <table className="summary">
          <tbody>
            {cart.items.map((i) => (
              <tr key={i.productId}>
                <td>{i.quantity} x {i.title}</td>
                <td>{usd(i.lineTotal)}</td>
              </tr>
            ))}
            <tr><td>Shipping</td><td>{usd(cart.shipping)}</td></tr>
            <tr className="summary__total"><td>Total charged</td><td>{usd(cart.total)}</td></tr>
            <tr><td>Your budget cap</td><td>{usd(budget)}</td></tr>
          </tbody>
        </table>
        <ul className="checklist">
          <li>Prices come from Channel3, not from the AI.</li>
          <li>You will log in and approve on {paypalMode === 'mock' ? 'a mock PayPal page' : 'PayPal Sandbox'}.</li>
          <li>The payment is captured only after you approve.</li>
        </ul>
        {testBuyer && (
          <div className="buyer">
            <div className="buyer__k">PayPal Sandbox test buyer (fake money)</div>
            <div className="buyer__row"><span>Email</span><code>{testBuyer.email}</code><Copy value={testBuyer.email} /></div>
            <div className="buyer__row"><span>Password</span><code>{testBuyer.password}</code><Copy value={testBuyer.password} /></div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Back</button>
          <button type="button" className="btn btn--paypal" ref={payRef} onClick={onConfirm} disabled={busy}>
            {busy ? 'Creating PayPal order...' : `Pay ${usd(cart.total)} with PayPal`}
          </button>
        </div>
      </div>
    </div>
  )
}
