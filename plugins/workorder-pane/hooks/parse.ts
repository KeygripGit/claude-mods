// Parses one Keygrip work order (the markdown kg_fetch_workorder returns) into sections.
// It keys on the document's fixed headings; issue #1516 asks the server for JSON so this can go.

export type Field = { name: string; target: string; value: string; chars: number; unchanged: boolean; limit?: number }
export type Edit = { n: number; of: number; title: string; why: string; where: string; find: string; replace: string; kind: 'replace' | 'remove' | 'insert' }
export type WorkOrder = {
  title: string
  mode: string
  prepared: string
  keywordTarget: string
  whatChanged: string
  fields: Field[]
  edits: Edit[]
  bodyIntro: string
  fullBody: string | null
  schema: string | null
  heroImage: string
  recommended: string
  checked: string
  verify: string[]
  reportBack: string
  contextChanged: string
}

const LIMITS: Record<string, number> = {
  'TITLE': 60, 'META TITLE': 60, 'META DESCRIPTION': 160, 'OG TITLE': 60, 'OG DESCRIPTION': 200,
}

function fences(text: string): string[] {
  const out: string[] = []
  const re = /```[a-zA-Z]*\n([\s\S]*?)\n```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? '')
  return out
}

function splitOn(text: string, marker: string): { head: string; parts: { heading: string; body: string }[] } {
  const chunks = `\n${text}`.split(`\n${marker}`)
  const head = (chunks[0] ?? '').replace(/^\n/, '')
  const parts = chunks.slice(1).map(c => {
    const nl = c.indexOf('\n')
    return nl === -1 ? { heading: c.trim(), body: '' } : { heading: c.slice(0, nl).trim(), body: c.slice(nl + 1) }
  })
  return { head, parts }
}

function line(text: string, label: string): string {
  const m = new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*(.*)`).exec(text)
  return m?.[1]?.trim() ?? ''
}

function parseEdits(body: string): { intro: string; edits: Edit[]; fullBody: string | null } {
  const { head, parts } = splitOn(body, '#### ')
  if (parts.length === 0) {
    const blocks = fences(body)
    return { intro: head.trim(), edits: [], fullBody: blocks[0] ?? null }
  }
  const edits = parts.map((p, i) => {
    const m = /^Edit (\d+) of (\d+):\s*(.*)$/.exec(p.heading)
    const title = m?.[3] ?? p.heading
    const findIdx = p.body.indexOf('**Find')
    const afterIdx = Math.max(p.body.indexOf('**Replace with'), p.body.indexOf('**Insert'))
    const find = findIdx === -1 ? '' : (fences(p.body.slice(findIdx, afterIdx === -1 ? undefined : afterIdx))[0] ?? '')
    const tail = afterIdx === -1 ? '' : p.body.slice(afterIdx)
    const removes = /\*\*Replace with:\*\*\s*nothing/i.test(tail)
    const replace = removes ? '' : (fences(tail)[0] ?? '')
    const kind: Edit['kind'] = removes ? 'remove' : find ? 'replace' : 'insert'
    return {
      n: Number(m?.[1] ?? i + 1), of: Number(m?.[2] ?? parts.length), title,
      why: line(p.body, 'Why'), where: line(p.body, 'Where'), find, replace, kind,
    }
  })
  return { intro: head.trim(), edits, fullBody: null }
}

export function parseWorkOrder(md: string): WorkOrder {
  const { head, parts } = splitOn(md, '## ')
  const section = (prefix: string) => parts.find(p => p.heading.startsWith(prefix))
  const wo: WorkOrder = {
    title: (/^# Workorder:\s*(.*)$/m.exec(head)?.[1] ?? '').trim(),
    mode: line(head, 'Mode'),
    prepared: line(head, 'Prepared'),
    keywordTarget: section('Keyword target')?.body.trim() ?? '',
    whatChanged: section('What changed')?.body.trim() ?? '',
    fields: [], edits: [], bodyIntro: '', fullBody: null, schema: null,
    heroImage: section('Hero image')?.body.trim() ?? '',
    recommended: section('Recommended')?.body.trim() ?? '',
    checked: section('Checked and left alone')?.body.trim() ?? '',
    verify: (section('Verify')?.body ?? '').split('\n').map(l => /^\d+\.\s+(.*)$/.exec(l)?.[1] ?? '').filter(Boolean),
    reportBack: section('Report back')?.body.trim() ?? '',
    contextChanged: section('Context changed')?.body.trim() ?? '',
  }
  const deploy = section('Deployable fields')
  if (deploy) {
    for (const h3 of splitOn(deploy.body, '### ').parts) {
      const arrow = /^(.*?)\s+→\s+(.*)$/.exec(h3.heading)
      const name = (arrow?.[1] ?? h3.heading).trim()
      const target = (arrow?.[2] ?? '').trim()
      if (name === 'BODY') {
        const { intro, edits, fullBody } = parseEdits(h3.body)
        wo.bodyIntro = intro; wo.edits = edits; wo.fullBody = fullBody
      } else if (name.startsWith('JSON-LD')) {
        const block = fences(h3.body)[0] ?? ''
        wo.schema = block.replace(/^\s*<script[^>]*>\s*/i, '').replace(/\s*<\/script>\s*$/i, '')
      } else {
        const value = fences(h3.body)[0] ?? ''
        const chars = Number(/`(\d+) chars`/.exec(h3.body)?.[1] ?? value.length)
        wo.fields.push({ name, target, value, chars, unchanged: /Unchanged:/.test(h3.body), limit: LIMITS[name] })
      }
    }
  }
  return wo
}

export type QueueRow = {
  id: number; keyword: string; page_url: string; slug: string; version: number; mode: string
  blocked: boolean; blocker_count: number; deployed_at: string | null; deployed_url: string; status: string
  // The approval stamp (#1518): a person said this version may be published. Per version.
  approved_at?: string | null; approved_by?: string
}

// kg_* results arrive as a text block holding {"result": <json string or markdown>, "keygrip_tools_version": ...}.
export function unwrap(blocks: { type: string; text?: string }[]): string {
  const text = blocks.find(b => b.type === 'text')?.text ?? ''
  try {
    const outer = JSON.parse(text) as { result?: unknown }
    if (typeof outer.result === 'string') return outer.result
    if (outer.result !== undefined) return JSON.stringify(outer.result)
  } catch { /* the text is the result itself */ }
  return text
}
