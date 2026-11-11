import { randomUUID } from 'node:crypto'

// In-memory store. Enough for a demo; restart clears everything.
const sessions = new Map()
const orders = new Map()

const SESSION_TTL_MS = 6 * 60 * 60 * 1000

export function createSession() {
  const session = {
    id: randomUUID(),
    createdAt: Date.now(),
    budget: null,
    catalog: new Map(),
    cart: null,
    orderIds: [],
    approvals: new Map(),
    messages: [],
    activity: [],
  }
  sessions.set(session.id, session)
  return session
}

export function getSession(id) {
  const session = sessions.get(id)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(id)
    return null
  }
  return session
}

export function saveOrder(order) {
  orders.set(order.orderId, order)
  return order
}

export function getOrder(orderId) {
  return orders.get(orderId) || null
}

// Ownership check: an order is visible only to the session that created it.
export function getSessionOrder(session, orderId) {
  const order = orders.get(orderId)
  return order && order.sessionId === session.id ? order : null
}

export function sessionOrders(session) {
  return session.orderIds.map((id) => orders.get(id)).filter(Boolean)
}

export function logActivity(session, entry) {
  const item = { id: randomUUID(), at: new Date().toISOString(), ...entry }
  session.activity = [item, ...session.activity].slice(0, 80)
  return item
}

export function addApproval(session, approval) {
  const item = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending', ...approval }
  session.approvals.set(item.id, item)
  return item
}

const OPEN_PACKAGE = new Set(['awaiting_shipment', 'in_transit'])

// Cents per order: captured packages, packages still on hold, refunds.
function orderCents(o) {
  const packages = o.packages || []
  const captured = packages.filter((p) => p.captureId).reduce((s, p) => s + Math.round(p.amount * 100), 0)
  const held = o.authorizationStatus === 'VOIDED' ? 0 : packages.filter((p) => OPEN_PACKAGE.has(p.status)).reduce((s, p) => s + Math.round(p.amount * 100), 0)
  const released = packages.filter((p) => p.status === 'released').reduce((s, p) => s + Math.round(p.amount * 100), 0)
  const refunded = o.refunds.filter((r) => r.status !== 'FAILED').reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0)
  return { captured, held, released, refunded }
}

// Money committed in this session against the cap: charged (net of refunds) plus still on hold.
export function spentAmount(session, excludeOrderId = null) {
  const cents = sessionOrders(session)
    .filter((o) => o.authorizationId && o.orderId !== excludeOrderId)
    .reduce((sum, o) => {
      const c = orderCents(o)
      return sum + c.captured + c.held - c.refunded
    }, 0)
  return cents / 100
}

// Money actually charged in this session (captured minus refunded).
export function chargedTotal(session) {
  return sessionOrders(session).reduce((sum, o) => {
    const c = orderCents(o)
    return sum + c.captured - c.refunded
  }, 0) / 100
}

function withMoney(o) {
  const c = orderCents(o)
  return { ...o, money: { charged: (c.captured - c.refunded) / 100, held: c.held / 100, released: c.released / 100, refunded: c.refunded / 100 } }
}

export function publicState(session) {
  return {
    sessionId: session.id,
    budget: session.budget,
    spent: spentAmount(session),
    charged: chargedTotal(session),
    cart: session.cart,
    orders: sessionOrders(session).map(withMoney),
    approvals: [...session.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    activity: session.activity,
  }
}
