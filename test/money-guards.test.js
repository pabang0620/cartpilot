// End-to-end money guards against the real Express app in mock mode (no outside calls).
// Run: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const PORT = 3099
const BASE = `http://127.0.0.1:${PORT}`
let server

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), FORCE_MOCK: '1', PUBLIC_URL: BASE, APP_URL: BASE, CHAT_PER_IP_HOUR: '1000', CHAT_PER_DAY: '10000' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server did not start')
})

after(() => server?.kill())

const post = async (path, body) => (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const put = async (path, body) => (await fetch(`${BASE}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const state = async (sid) => (await (await fetch(`${BASE}/api/state?sessionId=${sid}`)).json()).data
const chat = (sid, message) => post('/api/chat', { sessionId: sid, message })

async function newCart(message = 'two camping chairs under $300') {
  const sid = (await post('/api/session', {})).data.sessionId
  const r = await chat(sid, message)
  return { sid, cartId: r.data.state.cart.id }
}

// Mock PayPal approval page, then the return URL that captures.
async function approveAndReturn(sid, orderId) {
  await fetch(`${BASE}/mock-paypal/approve`, { method: 'POST', body: new URLSearchParams({ token: orderId }), redirect: 'manual' })
  const res = await fetch(`${BASE}/api/paypal/return?sid=${sid}&token=${orderId}`, { redirect: 'manual' })
  return new URL(res.headers.get('location')).searchParams
}

async function paidOrder() {
  const { sid, cartId } = await newCart()
  const orderId = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  await approveAndReturn(sid, orderId)
  return { sid, orderId }
}

test('full journey: cart, pay, ship, partial refund', async () => {
  const { sid, orderId } = await paidOrder()
  let s = await state(sid)
  assert.equal(s.orders[0].status, 'COMPLETED')
  assert.ok(s.orders[0].captureId)
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const r = await chat(sid, 'One chair arrived with a broken leg. Refund that one.')
  const card = r.data.state.approvals.find((a) => a.status === 'pending')
  assert.ok(card.amount < s.orders[0].total)
  s = await post(`/api/approvals/${card.id}`, { sessionId: sid, decision: 'approve' })
  assert.equal(s.data.orders[0].status, 'PARTIALLY_REFUNDED')
})

test('paying twice for one cart captures only the latest order', async () => {
  const { sid, cartId } = await newCart()
  const first = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  const second = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  assert.ok((await approveAndReturn(sid, first)).get('error'))
  assert.equal((await approveAndReturn(sid, second)).get('paid'), second)
  const captured = (await state(sid)).orders.filter((o) => o.captureId)
  assert.equal(captured.length, 1)
})

test('a cancelled PayPal order is never captured', async () => {
  const { sid, cartId } = await newCart()
  const orderId = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  await fetch(`${BASE}/api/paypal/cancel?sid=${sid}&token=${orderId}`, { redirect: 'manual' })
  assert.ok((await approveAndReturn(sid, orderId)).get('error'))
  assert.equal((await state(sid)).orders[0].captureId, null)
})

test('lowering the cap after checkout blocks the capture', async () => {
  const { sid, cartId } = await newCart()
  const orderId = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  await put('/api/budget', { sessionId: sid, amount: 10 })
  assert.ok((await approveAndReturn(sid, orderId)).get('error'))
  assert.equal((await state(sid)).orders[0].captureId, null)
})

test('an open claim reserves money so the same item cannot also be refunded', async () => {
  const { sid } = await paidOrder()
  await chat(sid, 'One chair never arrived. Open a claim.')
  await chat(sid, 'refund one chair')
  await chat(sid, 'refund one chair')
  const s = await state(sid)
  const reserved = s.approvals.filter((a) => a.status === 'pending').reduce((t, a) => t + a.amount, 0)
    + s.orders[0].disputes.reduce((t, d) => t + d.amount, 0)
  assert.ok(reserved <= s.orders[0].total + 0.001)
})

test('sessions are isolated', async () => {
  const a = await newCart()
  const b = (await post('/api/session', {})).data.sessionId
  const r = await post('/api/checkout', { sessionId: b, cartId: a.cartId })
  assert.equal(r.success, false)
})

test('unknown API routes answer JSON 404', async () => {
  const res = await fetch(`${BASE}/api/nope`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).success, false)
})
