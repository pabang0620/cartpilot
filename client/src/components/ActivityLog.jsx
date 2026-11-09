const SOURCE_LABEL = {
  channel3: 'CHANNEL3',
  'paypal-agent-toolkit': 'PAYPAL TOOLKIT',
  app: 'APP',
  human: 'YOU',
}

export default function ActivityLog({ activity }) {
  return (
    <details className="activity">
      <summary>Activity log <span>{activity.length} tool calls, newest first</span></summary>
      {activity.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ol className="log">
        {activity.map((a) => (
          <li key={a.id} className={a.ok ? '' : 'log--error'}>
            <span className="log__t num">{new Date(a.at).toLocaleTimeString()}</span>
            <span className="log__src">{SOURCE_LABEL[a.source] || a.source}</span>
            <span className="log__fn">{a.tool}{(a.origin === 'shopper' || a.source === 'human') && <span className="you">you</span>}</span>
            {a.detail && <span className="log__detail">{a.detail}</span>}
          </li>
        ))}
      </ol>
    </details>
  )
}
