import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import Icon from './Icons.jsx'
import ActivityLog from './ActivityLog.jsx'

const STORY = [
  'I need three camping chairs for a festival, under $300 total. Light and comfortable.',
  'Where are my chairs?',
  'One chair arrived with a broken leg. Refund that one.',
  'The third chair never arrived.',
  'Find two replacement chairs inside my budget.',
]

const SOURCE_LABEL = { channel3: 'CHANNEL3', 'paypal-agent-toolkit': 'PAYPAL', 'paypal-rest': 'PAYPAL', app: 'APP' }

function Via({ events }) {
  if (!events?.length) return null
  return (
    <div className="via">
      via {events.map((e, i) => (
        <span key={i} className={e.ok ? '' : 'via--err'} title={JSON.stringify(e.input || {})}>
          {i > 0 && ' · '}{SOURCE_LABEL[e.source] || e.source} {e.tool}
        </span>
      ))}
    </div>
  )
}

export default function ChatPanel({ messages, busy, onSend, activity, hasPaid, testBuyer }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    // Keep the intro at the top; follow the conversation once it starts.
    if (el && messages.length > 0) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  function submit(text) {
    const value = text.trim()
    if (!value || busy) return
    setDraft('')
    onSend(value)
    inputRef.current?.focus()
  }

  // Suggest the next line of the demo story the shopper has not sent yet.
  const sent = new Set(messages.filter((m) => m.role === 'user').map((m) => m.text))
  const next = STORY.filter((q, i) => !sent.has(q) && (i === 0 || hasPaid)).slice(0, 2)

  return (
    <section className="chat" aria-label="Agent chat">
      <div className="chat__h"><h2>Agent</h2><small>You approve every payment</small></div>
      <div className="thread" ref={listRef}>
        {messages.length === 0 && (
          <div className="intro">
            <p className="intro__lead">Tell CartPilot what you need and your budget. It finds the products and fills a cart. At checkout PayPal only holds the money, and each package is charged when it is delivered.</p>
            <p className="muted">If a package never arrives, you never pay for it: no refund to chase, no chargeback. The agent cannot raise your cap or move money on its own.</p>
            {testBuyer && (
              <p className="intro__judge">
                <b>Testing tip.</b> At checkout, log in to PayPal with the Sandbox test buyer <code>{testBuyer.email}</code> (shown again in the payment dialog). Back here, press <b>Quick demo</b> in the <b>Demo merchant console</b> (purchase panel): it ships, delivers two packages and the carrier loses the third. Then continue with steps 2 to 5. <b>Start over</b> at the top resets everything.
              </p>
            )}
            <p className="intro__k">Try the full story</p>
            <ol className="story">
              {STORY.map((q) => (
                <li key={q}><button type="button" disabled={busy} onClick={() => submit(q)}>{q}</button></li>
              ))}
            </ol>
          </div>
        )}
        {messages.map((m, i) => (
          m.role === 'user'
            ? <div key={i} className="msg-user">{m.text}</div>
            : (
              <div key={i} className="msg-agent">
                <div className="who"><b>CartPilot</b>{m.answeredBy && m.answeredBy !== 'claude' && <span className="who__alt"> · {m.answeredBy}</span>}</div>
                <Markdown text={m.text} />
                <Via events={m.events} />
              </div>
            )
        ))}
        {busy && <div className="msg-agent typing" aria-label="Agent is working"><span /><span /><span /></div>}
      </div>
      {messages.length > 0 && next.length > 0 && (
        <div className="suggest">
          {next.map((q) => <button key={q} type="button" disabled={busy} onClick={() => submit(q)}>{q}</button>)}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. A quiet desk lamp under $120"
          maxLength={2000}
          aria-label="Message the agent"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}><Icon name="send" />Send</button>
      </form>
      <ActivityLog activity={activity} />
    </section>
  )
}
