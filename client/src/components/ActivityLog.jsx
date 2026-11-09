const SOURCE_LABEL = {
  channel3: 'Channel3',
  'paypal-agent-toolkit': 'PayPal Toolkit',
  app: 'App',
  human: 'You',
}

export default function ActivityLog({ activity }) {
  return (
    <section className="panel activity">
      <header className="panel__head">
        <h2>Activity</h2>
        <span className="muted small">Every tool call, newest first</span>
      </header>
      {activity.length === 0 && <p className="muted empty">Nothing yet.</p>}
      <ol className="log">
        {activity.map((a) => (
          <li key={a.id} className={a.ok ? '' : 'log--error'}>
            <span className={`chip chip--${a.source}`}><span className="chip__src">{SOURCE_LABEL[a.source] || a.source}</span>{a.tool}</span>
            <span className="small muted">{a.origin} · {new Date(a.at).toLocaleTimeString()}</span>
            {a.detail && <div className="small log__detail">{a.detail}</div>}
          </li>
        ))}
      </ol>
    </section>
  )
}
