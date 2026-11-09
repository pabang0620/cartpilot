import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'

const QUICK_PROMPTS = [
  'I need two camping chairs for a festival, under $300 total. Light and comfortable.',
  'Where are my chairs?',
  'One chair arrived with a broken leg. Refund that one.',
  'The other chair never arrived. Open a claim.',
]

const SOURCE_LABEL = {
  channel3: 'Channel3',
  'paypal-agent-toolkit': 'PayPal Toolkit',
  app: 'App',
}

function ToolChips({ events }) {
  if (!events?.length) return null
  return (
    <div className="chips">
      {events.map((e, i) => (
        <span key={i} className={`chip chip--${e.source} ${e.ok ? '' : 'chip--error'}`} title={JSON.stringify(e.input)}>
          <span className="chip__src">{SOURCE_LABEL[e.source] || e.source}</span>
          {e.tool}
        </span>
      ))}
    </div>
  )
}

export default function ChatPanel({ messages, busy, onSend }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  function submit(text) {
    const value = text.trim()
    if (!value || busy) return
    setDraft('')
    onSend(value)
  }

  return (
    <section className="panel chat">
      <header className="panel__head">
        <h2>Agent</h2>
        <span className="muted">Tell it what you need</span>
      </header>
      <div className="chat__list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat__empty">
            <p><strong>Find it, buy it, fix it.</strong></p>
            <p className="muted">CartPilot searches real products with Channel3, fills a cart inside your budget, and you approve payment on PayPal. After the order it tracks shipping, prepares refunds and files claims. Nothing moves money without your click.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>
            {m.role === 'agent' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            {m.role === 'agent' && <ToolChips events={m.events} />}
          </div>
        ))}
        {busy && <div className="msg msg--agent msg--typing"><span /><span /><span /></div>}
      </div>
      <div className="chat__quick">
        {QUICK_PROMPTS.map((q) => (
          <button key={q} type="button" className="quick" disabled={busy} onClick={() => submit(q)}>{q}</button>
        ))}
      </div>
      <form className="chat__form" onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. A quiet desk lamp under $120"
          maxLength={2000}
          aria-label="Message the agent"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>Send</button>
      </form>
    </section>
  )
}
