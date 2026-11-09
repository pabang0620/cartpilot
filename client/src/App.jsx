import { useCallback, useEffect, useRef, useState } from 'react'
import { api, storage } from './api.js'
import ChatPanel from './components/ChatPanel.jsx'
import CheckoutModal from './components/CheckoutModal.jsx'
import JourneyPanel, { MiniSteps } from './components/JourneyPanel.jsx'
import Icon from './components/Icons.jsx'

const EMPTY_STATE = { budget: null, spent: 0, cart: null, orders: [], approvals: [], activity: [] }

const MODE_LABEL = { live: 'Live', sandbox: 'Sandbox', mock: 'Mock' }

function ModeBadges({ modes }) {
  if (!modes) return null
  const items = [['Claude', modes.llm], ['PayPal', modes.paypal], ['Channel3', modes.channel3]]
  return (
    <div className="modes">
      {items.map(([name, mode], i) => (
        <span key={name} className={`mode mode--${mode}`}>{i > 0 && ' · '}<b>{name}</b> {MODE_LABEL[mode].toLowerCase()}</span>
      ))}
    </div>
  )
}

export default function App() {
  const [sessionId, setSessionId] = useState(null)
  const [modes, setModes] = useState(null)
  const [state, setState] = useState(EMPTY_STATE)
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [showCheckout, setShowCheckout] = useState(false)
  const [checkoutError, setCheckoutError] = useState(null)
  const started = useRef(false)

  const notify = useCallback((text, kind = 'info') => setToast({ text, kind, at: Date.now() }), [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (started.current) return
    started.current = true
    const params = new URLSearchParams(window.location.search)
    const stored = storage.get()

    async function boot() {
      const health = await api.health()
      setModes(health.modes)
      let data = null
      let history = []
      if (stored?.sessionId) {
        try {
          data = await api.state(stored.sessionId)
          history = Array.isArray(stored.messages) ? stored.messages : []
        } catch {
          data = null
        }
      }
      if (!data) data = await api.createSession()
      setSessionId(data.sessionId)
      setState(data)

      if (params.get('paid')) {
        history = [...history, { role: 'agent', text: `Payment approved on PayPal and captured for order **${params.get('paid')}**. Ask me to track it, refund it or file a claim any time.`, events: [{ tool: 'pay_order', source: 'paypal-agent-toolkit', ok: true }] }]
        notify('Payment captured', 'success')
      } else if (params.get('error')) {
        notify(params.get('error'), 'error')
      } else if (params.get('cancelled')) {
        notify('PayPal payment cancelled. Your cart is still here.')
      }
      setMessages(history)
      if (params.toString()) window.history.replaceState(null, '', window.location.pathname)
    }

    boot().catch((err) => notify(`Could not start: ${err.message}`, 'error'))
  }, [notify])

  useEffect(() => {
    if (sessionId) storage.set({ sessionId, messages: messages.slice(-40) })
  }, [sessionId, messages])

  async function send(text) {
    setMessages((m) => [...m, { role: 'user', text }])
    setBusy(true)
    try {
      const data = await api.chat(sessionId, text)
      setMessages((m) => [...m, { role: 'agent', text: data.reply, events: data.events }])
      setState(data.state)
    } catch (err) {
      setMessages((m) => [...m, { role: 'agent', text: `Something went wrong: ${err.message}`, events: [] }])
    } finally {
      setBusy(false)
    }
  }

  async function withAction(fn) {
    setActionBusy(true)
    try {
      await fn()
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setActionBusy(false)
    }
  }

  const setBudget = (amount) => withAction(async () => {
    setState(await api.setBudget(sessionId, amount))
    notify(`Budget cap set to $${amount}`)
  })

  async function confirmCheckout() {
    setCheckoutError(null)
    setActionBusy(true)
    try {
      const data = await api.checkout(sessionId, state.cart.id)
      setState(data.state)
      window.location.assign(data.approveUrl)
    } catch (err) {
      setCheckoutError(err.message)
      setActionBusy(false)
    }
  }

  const decide = (approvalId, decision) => withAction(async () => {
    const next = await api.decide(sessionId, approvalId, decision)
    setState(next)
    const approval = next.approvals.find((a) => a.id === approvalId)
    if (approval?.status === 'failed') notify(approval.error, 'error')
    else notify(decision === 'approve' ? 'Approved. PayPal call done.' : 'Rejected. Nothing was charged or refunded.', 'success')
  })

  const ship = (orderId) => withAction(async () => {
    setState(await api.ship(sessionId, orderId))
    notify('Seller added tracking on PayPal')
  })

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Icon name="cart" className="brand__i" />
          <h1>CartPilot</h1>
          <p>Find it, buy it, fix it.</p>
        </div>
        <ModeBadges modes={modes} />
      </header>
      <MiniSteps state={state} />

      <main className="layout">
        <ChatPanel messages={messages} busy={busy || !sessionId} onSend={send} activity={state.activity} hasPaid={state.orders.some((o) => o.captureId)} />
        <JourneyPanel
          state={state}
          busy={actionBusy}
          onBudget={setBudget}
          onReview={() => { setCheckoutError(null); setShowCheckout(true) }}
          onDecide={decide}
          onShip={ship}
        />
      </main>

      {showCheckout && state.cart && (
        <CheckoutModal
          cart={state.cart}
          budget={state.budget}
          paypalMode={modes?.paypal}
          busy={actionBusy}
          error={checkoutError}
          onConfirm={confirmCheckout}
          onClose={() => setShowCheckout(false)}
        />
      )}

      {toast && <div className={`toast toast--${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  )
}
