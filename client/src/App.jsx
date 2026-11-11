import { useCallback, useEffect, useRef, useState } from 'react'
import { api, storage } from './api.js'
import ChatPanel from './components/ChatPanel.jsx'
import CheckoutModal from './components/CheckoutModal.jsx'
import JourneyPanel, { MiniSteps } from './components/JourneyPanel.jsx'
import Icon from './components/Icons.jsx'

const EMPTY_STATE = { budget: null, spent: 0, charged: 0, cart: null, orders: [], approvals: [], activity: [] }

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
  const [testBuyer, setTestBuyer] = useState(null)
  const [policy, setPolicy] = useState([])
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
      setTestBuyer(health.testBuyer || null)
      setPolicy(health.merchantPolicy || [])
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
        history = [...history, { role: 'agent', text: `Approved on PayPal for order **${params.get('paid')}**. The total is **on hold, not charged**. Each package is charged when it is delivered, and anything that never arrives is never charged.`, events: [{ tool: 'authorize_order', source: 'paypal-rest', ok: true }] }]
        notify('Approved on PayPal: held, not charged', 'success')
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

  // Fresh session for the next tester: new cart, budget and orders.
  async function startOver() {
    if (busy || actionBusy) return
    const data = await api.createSession()
    setSessionId(data.sessionId)
    setState(data)
    setMessages([])
    setShowCheckout(false)
    notify('Started a new session')
  }

  async function send(text) {
    setMessages((m) => [...m, { role: 'user', text }])
    setBusy(true)
    try {
      const data = await api.chat(sessionId, text)
      setMessages((m) => [...m, { role: 'agent', text: data.reply, events: data.events, answeredBy: data.answeredBy }])
      setState(data.state)
      if (data.modes) setModes(data.modes)
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
    else notify(decision === 'approve' ? 'Sent. The merchant policy approved it and PayPal is updated.' : 'Rejected. Nothing was sent to the merchant.', 'success')
  })

  const ship = (orderId) => withAction(async () => {
    setState(await api.ship(sessionId, orderId))
    notify('Merchant shipped the packages')
  })

  const lost = (orderId, packageId) => withAction(async () => {
    setState(await api.lost(sessionId, orderId, packageId))
    notify(`Carrier reported ${packageId} lost. It stays on hold and is not charged.`)
  })

  const play = (orderId) => withAction(async () => {
    setState(await api.play(sessionId, orderId))
    notify('Merchant shipped, two deliveries charged, the carrier lost the last package', 'success')
  })

  const deliver = (orderId, packageId) => withAction(async () => {
    const next = await api.deliver(sessionId, orderId, packageId)
    setState(next)
    const pkg = next.orders.find((o) => o.orderId === orderId)?.packages.find((p) => p.id === packageId)
    notify(`${packageId} delivered: PayPal charged $${pkg?.amount?.toFixed(2)} for it`, 'success')
  })

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Icon name="cart" className="brand__i" />
          <h1>CartPilot</h1>
          <p>Find it, buy it, fix it.</p>
        </div>
        <div className="top__right">
          <ModeBadges modes={modes} />
          <button type="button" className="btn btn--ghost top__reset" onClick={startOver}>Start over</button>
        </div>
      </header>
      <MiniSteps state={state} />

      <main className="layout">
        <ChatPanel testBuyer={testBuyer} messages={messages} busy={busy || !sessionId} onSend={send} activity={state.activity} hasPaid={state.orders.some((o) => o.authorizationId)} />
        <JourneyPanel
          state={state}
          busy={actionBusy}
          onBudget={setBudget}
          onReview={() => { setCheckoutError(null); setShowCheckout(true) }}
          onDecide={decide}
          onShip={ship}
          onDeliver={deliver}
          onLost={lost}
          onPlay={play}
          policy={policy}
        />
      </main>

      {showCheckout && state.cart && (
        <CheckoutModal
          cart={state.cart}
          budget={state.budget}
          paypalMode={modes?.paypal}
          testBuyer={testBuyer}
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
