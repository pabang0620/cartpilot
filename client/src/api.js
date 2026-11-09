async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }))
  if (!res.ok || !json.success) {
    const err = new Error(json.message || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return json.data
}

export const api = {
  createSession: () => request('POST', '/api/session'),
  health: () => request('GET', '/api/health'),
  state: (sessionId) => request('GET', `/api/state?sessionId=${encodeURIComponent(sessionId)}`),
  setBudget: (sessionId, amount) => request('PUT', '/api/budget', { sessionId, amount }),
  chat: (sessionId, message) => request('POST', '/api/chat', { sessionId, message }),
  checkout: (sessionId, cartId) => request('POST', '/api/checkout', { sessionId, cartId }),
  decide: (sessionId, approvalId, decision) => request('POST', `/api/approvals/${approvalId}`, { sessionId, decision }),
  ship: (sessionId, orderId) => request('POST', '/api/seller/ship', { sessionId, orderId }),
}

const KEY = 'cartpilot.session'
export const storage = {
  get() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null }
  },
  set(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
  },
}

export const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '-' : `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n)).toFixed(2)}`)
