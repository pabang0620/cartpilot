// Tiny safe markdown renderer for agent replies: paragraphs, lists, tables, **bold**, _italic_, `code`, links.
// Builds React elements, never injects HTML.

function inline(text, keyPrefix) {
  const parts = []
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|https?:\/\/[^\s)|]+)/g
  let last = 0
  let match
  let i = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${i++}`
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (link) parts.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>)
    else if (token.startsWith('**')) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('_')) parts.push(<em key={key}>{token.slice(1, -1)}</em>)
    else if (token.startsWith('`')) parts.push(<code key={key}>{token.slice(1, -1)}</code>)
    else parts.push(<a key={key} href={token} target="_blank" rel="noreferrer">{token}</a>)
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export default function Markdown({ text }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const header = cells(line)
      const rows = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      blocks.push(
        <div className="md-table" key={`t${i}`}>
          <table>
            <thead><tr>{header.map((h, k) => <th key={k}>{inline(h, `h${i}${k}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, k) => <td key={k}>{inline(c, `c${i}${ri}${k}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      blocks.push(<ul key={`l${i}`}>{items.map((it, k) => <li key={k}>{inline(it, `li${i}${k}`)}</li>)}</ul>)
      continue
    }
    if (/^#{1,4}\s+/.test(line)) {
      blocks.push(<p className="md-h" key={`h${i}`}><strong>{inline(line.replace(/^#{1,4}\s+/, ''), `hd${i}`)}</strong></p>)
      i += 1
      continue
    }
    if (line.trim()) {
      const para = []
      while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++])
      blocks.push(<p key={`p${i}`}>{inline(para.join(' '), `p${i}`)}</p>)
      continue
    }
    i += 1
  }
  return <div className="md">{blocks}</div>
}
