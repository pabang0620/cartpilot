import { Router } from 'express'
import { modes } from './config.js'
import { mockPaypal } from './integrations/paypal.js'

// Local stand-in for the PayPal approval screen. Only mounted in MOCK PayPal mode.
export const mockPaypalRouter = Router()

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function withToken(url, token) {
  const u = new URL(url)
  u.searchParams.set('token', token)
  u.searchParams.set('PayerID', 'MOCKPAYER123')
  return u.toString()
}

mockPaypalRouter.use((req, res, next) => {
  if (modes.paypal !== 'mock') return res.status(404).send('Not found')
  next()
})

mockPaypalRouter.get('/checkout', (req, res) => {
  const token = String(req.query.token || '')
  const order = mockPaypal.peek(token)
  if (!order) return res.status(404).send('Unknown order')
  const unit = order.purchase_units[0]
  const rows = unit.items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.quantity)}</td><td>$${escapeHtml(i.unit_amount.value)}</td></tr>`).join('')
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayPal Sandbox (mock)</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f7fa; margin: 0; padding: 16px; color: #1a1a1a; }
  .card { max-width: 440px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
  .logo { font-weight: 800; font-size: 22px; color: #003087; } .logo span { color: #009cde; }
  .tag { display: inline-block; font-size: 12px; background: #fff4e5; color: #8a5300; padding: 2px 8px; border-radius: 6px; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; } td { padding: 6px 0; border-bottom: 1px solid #eee; }
  .total { font-size: 20px; font-weight: 700; margin: 12px 0 20px; }
  button { width: 100%; padding: 12px; border-radius: 24px; border: 0; font-size: 16px; font-weight: 700; cursor: pointer; margin-bottom: 10px; }
  .pay { background: #ffc439; color: #111; } .cancel { background: #eef1f5; color: #333; }
</style></head>
<body><div class="card">
  <div class="logo">Pay<span>Pal</span><span class="tag">MOCK SANDBOX</span></div>
  <p>Order <code>${escapeHtml(order.id)}</code></p>
  <table>${rows}</table>
  <div class="total">Total $${escapeHtml(unit.amount.value)} USD</div>
  <form method="post" action="/mock-paypal/approve"><input type="hidden" name="token" value="${escapeHtml(token)}"><button class="pay" type="submit">Approve payment</button></form>
  <form method="post" action="/mock-paypal/cancel"><input type="hidden" name="token" value="${escapeHtml(token)}"><button class="cancel" type="submit">Cancel and return</button></form>
</div></body></html>`)
})

mockPaypalRouter.post('/approve', (req, res) => {
  const token = String(req.body?.token || '')
  const approved = mockPaypal.approve(token)
  if (!approved) return res.status(404).send('Unknown order')
  res.redirect(withToken(approved.returnUrl, token))
})

mockPaypalRouter.post('/cancel', (req, res) => {
  const token = String(req.body?.token || '')
  const order = mockPaypal.peek(token)
  if (!order) return res.status(404).send('Unknown order')
  res.redirect(withToken(order.cancelUrl, token))
})
