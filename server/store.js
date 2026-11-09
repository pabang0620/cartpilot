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

export function publicState(session) {
  return {
    sessionId: session.id,
    budget: session.budget,
    cart: session.cart,
    orders: sessionOrders(session),
    approvals: [...session.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    activity: session.activity,
  }
}
