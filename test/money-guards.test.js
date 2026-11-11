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
const round = (n) => Math.round(n * 100) / 100

async function newCart(message = 'three camping chairs under $300') {
  const sid = (await post('/api/session', {})).data.sessionId
  const r = await chat(sid, message)
  return { sid, cartId: r.data.state.cart.id }
}

// Mock PayPal approval page, then the return URL that authorizes (holds) the payment.
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

const deliver = (sid, orderId, packageId) => post('/api/seller/deliver', { sessionId: sid, orderId, packageId })
const approve = (sid, card) => post(`/api/approvals/${card.id}`, { sessionId: sid, decision: 'approve' })
const pendingCard = (s) => s.approvals.find((a) => a.status === 'pending')

test('checkout only holds the money, nothing is charged', async () => {
  const { sid } = await paidOrder()
  const s = await state(sid)
  const o = s.orders[0]
  assert.equal(o.status, 'AUTHORIZED')
  assert.ok(o.authorizationId)
  assert.equal(o.packages.length, 3)
  assert.equal(o.money.charged, 0)
  assert.equal(o.money.held, o.total)
  assert.equal(s.spent, o.total) // the hold counts against the cap
})

test('full journey: each delivery charges one package, a lost one is released, a broken one refunded', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  let s = await state(sid)
  const [p1, p2, p3] = s.orders[0].packages
  assert.equal(p1.status, 'in_transit')

  s = (await deliver(sid, orderId, p1.id)).data
  assert.equal(s.orders[0].money.charged, p1.amount)
  assert.equal(s.orders[0].status, 'PARTIALLY_CAPTURED')
  s = (await deliver(sid, orderId, p2.id)).data
  assert.equal(s.orders[0].money.charged, round(p1.amount + p2.amount))
  assert.ok(s.orders[0].packages[1].captureId)
  assert.notEqual(s.orders[0].packages[0].captureId, s.orders[0].packages[1].captureId)

  s = (await chat(sid, 'One chair arrived with a broken leg. Refund that one.')).data.state
  let card = pendingCard(s)
  assert.equal(card.type, 'refund')
  assert.equal(card.amount, p1.amount)
  s = (await approve(sid, card)).data
  assert.equal(s.orders[0].refunds[0].captureId, s.orders[0].packages[0].captureId)
  assert.equal(s.orders[0].status, 'PARTIALLY_CAPTURED') // still a package on hold, so not "refunded"

  await post('/api/seller/lost', { sessionId: sid, orderId, packageId: p3.id })
  s = (await chat(sid, 'The third chair never arrived.')).data.state
  card = pendingCard(s)
  assert.equal(card.type, 'release')
  assert.equal(card.packageId, p3.id)
  s = (await approve(sid, card)).data
  const o = s.orders[0]
  assert.equal(o.packages[2].status, 'released')
  assert.equal(o.authorizationStatus, 'VOIDED')
  assert.equal(o.money.held, 0)
  assert.equal(o.money.charged, p2.amount) // paid only for the chair that arrived intact
  assert.equal(s.spent, p2.amount)
})

test('a package in transit is not released before it is lost or late', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const r = await chat(sid, 'The third chair never arrived.')
  assert.equal(pendingCard(r.data.state), undefined)
  const pkgs = (await state(sid)).orders[0].packages
  assert.ok(pkgs.every((p) => p.status === 'in_transit'))
  await post('/api/seller/lost', { sessionId: sid, orderId, packageId: pkgs[0].id })
  const late = await deliver(sid, orderId, pkgs[0].id)
  assert.equal(late.success, false) // a lost package is not charged by a stray scan
})

test('two delivery scans at the same moment both charge exactly once', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const pkgs = (await state(sid)).orders[0].packages
  const results = await Promise.all([deliver(sid, orderId, pkgs[0].id), deliver(sid, orderId, pkgs[1].id), deliver(sid, orderId, pkgs[0].id)])
  assert.equal(results.filter((r) => r.success).length, 2)
  const o = (await state(sid)).orders[0]
  assert.equal(o.money.charged, round(pkgs[0].amount + pkgs[1].amount))
})

test('the merchant shortcut ships, delivers all but one, and the carrier loses the last', async () => {
  const { sid, orderId } = await paidOrder()
  const s = (await post('/api/seller/play', { sessionId: sid, orderId })).data
  const pk = s.orders[0].packages
  assert.deepEqual(pk.map((p) => p.status), ['delivered', 'delivered', 'in_transit'])
  assert.ok(pk[2].lostAt)
})

test('a package that was never delivered cannot be refunded or charged twice', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const pkgs = (await state(sid)).orders[0].packages
  const r = await chat(sid, 'refund one chair')
  assert.equal(pendingCard(r.data.state), undefined)
  await deliver(sid, orderId, pkgs[0].id)
  const again = await deliver(sid, orderId, pkgs[0].id)
  assert.equal(again.success, false)
  assert.equal((await state(sid)).orders[0].money.charged, pkgs[0].amount)
})

test('the last delivery is the final capture', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const pkgs = (await state(sid)).orders[0].packages
  for (const p of pkgs) await deliver(sid, orderId, p.id)
  const o = (await state(sid)).orders[0]
  assert.equal(o.authorizationStatus, 'CAPTURED')
  assert.equal(o.status, 'COMPLETED')
  assert.equal(o.money.charged, o.total)
})

test('paying twice for one cart authorizes only the latest order', async () => {
  const { sid, cartId } = await newCart()
  const first = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  const second = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  assert.ok((await approveAndReturn(sid, first)).get('error'))
  assert.equal((await approveAndReturn(sid, second)).get('paid'), second)
  const held = (await state(sid)).orders.filter((o) => o.authorizationId)
  assert.equal(held.length, 1)
})

test('a cancelled PayPal order is never authorized', async () => {
  const { sid, cartId } = await newCart()
  const orderId = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  await fetch(`${BASE}/api/paypal/cancel?sid=${sid}&token=${orderId}`, { redirect: 'manual' })
  assert.ok((await approveAndReturn(sid, orderId)).get('error'))
  assert.equal((await state(sid)).orders[0].authorizationId, null)
})

test('lowering the cap after checkout blocks the authorization', async () => {
  const { sid, cartId } = await newCart()
  const orderId = (await post('/api/checkout', { sessionId: sid, cartId })).data.orderId
  await put('/api/budget', { sessionId: sid, amount: 10 })
  assert.ok((await approveAndReturn(sid, orderId)).get('error'))
  assert.equal((await state(sid)).orders[0].authorizationId, null)
})

test('an open claim reserves money so the same package cannot also be refunded', async () => {
  const { sid, orderId } = await paidOrder()
  await post('/api/seller/ship', { sessionId: sid, orderId })
  const pkgs = (await state(sid)).orders[0].packages
  await deliver(sid, orderId, pkgs[0].id)
  await chat(sid, 'It is not as described. Open a claim.')
  await chat(sid, 'refund one chair')
  await chat(sid, 'refund one chair')
  const s = await state(sid)
  const reserved = s.approvals.filter((a) => a.status === 'pending').reduce((t, a) => t + a.amount, 0)
    + s.orders[0].disputes.reduce((t, d) => t + d.amount, 0)
  assert.ok(reserved <= pkgs[0].amount + 0.001)
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
