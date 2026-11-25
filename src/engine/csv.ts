

/** openQuote is the line of a quoted cell the file never closes: everything after it ended up in that one cell. */
export function parseCsv(text: string): { rows: string[][]; lines: number[]; openQuote?: number } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  let quoteLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '') { quoted = true; quoteLine = line }
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return quoted ? { rows, lines, openQuote: quoteLine } : { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

export function parseNum(raw: string): number {
  const s = raw.trim().replace(/[\s_]/g, '')
  if (s === '' || /^(null|nan|na|n\/a|-)$/i.test(s)) return NaN
  return Number(s)
}

/** Text a spreadsheet would run as a formula gets a leading apostrophe; numbers stay as they are. */
const inert = (s: string) => /^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? `'${s}` : s

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : inert(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

/** Categories as one line of text: comma separated, quoted where a category has a comma, a quote or space at its ends. */
export const formatList = (list: string[]) => list.map(s => /[",]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s).join(', ')

/** Reads formatList's text, and plain comma separated text. Blank items are dropped. */
export function parseList(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\s*(?:"((?:[^"]|"")*)"\s*(?=,|$)|([^,]*))(?:,|$)/g)) {
    const item = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].trim()
    if (item.trim()) out.push(item)
  }
  return out
}
