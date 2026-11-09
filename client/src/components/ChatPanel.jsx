import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import Icon from './Icons.jsx'
import ActivityLog from './ActivityLog.jsx'

const STORY = [
  'I need two camping chairs for a festival, under $300 total. Light and comfortable.',
  'Where are my chairs?',
  'One chair arrived with a broken leg. Refund that one.',
  'The other chair never arrived. Open a claim.',
]

const SOURCE_LABEL = { channel3: 'CHANNEL3', 'paypal-agent-toolkit': 'PAYPAL', app: 'APP' }

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

export default function ChatPanel({ messages, busy, onSend, activity, hasPaid }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
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
            <p className="intro__lead">Tell CartPilot what you need and your budget. It finds the products, fills a cart, and after you pay it tracks the order and handles refunds and claims.</p>
            <p className="muted">It never moves money on its own. Payments, refunds and claim settlements each wait for your click.</p>
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
                <div className="who"><b>CartPilot</b></div>
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
