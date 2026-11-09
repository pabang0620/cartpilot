import { useEffect } from 'react'
import { usd } from '../api.js'

export default function CheckoutModal({ cart, budget, paypalMode, busy, error, onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title" onClick={onClose}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
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
        {error && <p className="error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Back</button>
          <button type="button" className="btn btn--paypal" onClick={onConfirm} disabled={busy}>
            {busy ? 'Creating PayPal order...' : `Pay ${usd(cart.total)} with PayPal`}
          </button>
        </div>
      </div>
    </div>
  )
}
