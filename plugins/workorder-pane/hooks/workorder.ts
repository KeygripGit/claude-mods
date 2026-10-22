// The shapes the client MCP server answers with. A work order is kg_fetch_workorder(format="json")
// (issue #1524): the server builds it from the same work order IR it renders the markdown from,
// so nothing here reads headings, and a wording change in the document cannot empty a tab.

// band: the rubric's [min, max] characters for the field, null on a side with no limit.
export type Field = {
  role: string; name: string; target: string; value: string; chars: number
  band: [number | null, number | null]; measured: boolean; required: boolean
  blocked_reason: string; unchanged: boolean
}
// kind: replace_paragraph, replace_section, insert_after, insert_section, delete_paragraph,
// delete_section. before_text is the page's current text, after_html the new HTML ('' on a delete).
export type Edit = {
  id: string; kind: string; label: string; heading: string; locator: Record<string, unknown>
  before_text: string; after_html: string; why: string; where: string
}
export type StructuredData = { schema_type: string; script: string; json: string; injection: string; merge_strategy: string }
export type Recommendation = { label: string; heading: string; reason: string; text: string; suggestion: string }
export type ContextChange = { fact_id: number; reason: string; sections: string[]; text: string; recheck_due: boolean; recheck_at: string | null }
export type WorkOrder = {
  optimization_id: number; version: number; audience: string
  canonical: string; mode: string; prepared: string
  blocked: boolean; blocking: { kind: string; subject: string; reason: string }[]
  keyword: { primary: string; secondaries: string[] }
  what_changed: string[]
  fields: Field[]
  // paste: the html is the page body to deploy; false for a targeted-edits order, whose html is
  // the resulting article for reading only.
  body: { strategy: string; html: string; paste: boolean }
  edits: Edit[]
  structured_data: StructuredData[]
  assets: { url: string; alt: string; role: string; disposition: 'upload' | 'preserve' }[]
  redirect: { from_url: string; to_url: string; status: number } | null
  recommended: Recommendation[]
  checked: { label: string; reason: string }[]
  verify: string[]
  report_back: { tool: string; optimization_id: number; targets: string[] } | null
  context_changes: ContextChange[]
}

export function readWorkOrder(text: string): WorkOrder {
  const wo = JSON.parse(text) as WorkOrder
  if (!wo || !Array.isArray(wo.fields) || !Array.isArray(wo.verify)) throw new Error(`not a work order: ${text.slice(0, 120)}`)
  return wo
}

export type QueueRow = {
  // keyword is null for an order made from a URL with no target keyword (Silna #512).
  id: number; keyword: string | null; page_url: string; slug: string; version: number; mode: string
  blocked: boolean; blocker_count: number; deployed_at: string | null; deployed_url: string; status: string
  // The approval stamp (#1518): a person said this version may be published. Per version.
  approved_at?: string | null; approved_by?: string
  // The pull request this page was reported in (#1855, kg_pull_request), '' when none.
  pull_request_url?: string
}

// What a row is called: its keyword, else the page it changes. Never empty — the desktop
// table makes it a Button's label, and a Button without one makes the engine refuse the
// whole pane ("has not drawn in this pane", 2026-10-22).
export function rowLabel(r: Pick<QueueRow, 'id' | 'keyword' | 'slug' | 'page_url'>): string {
  return r.keyword || r.slug || r.page_url || `#${r.id}`
}

// The PR newly approved pages go onto (#1855): one open PR per batch in the client's repo.
export type OpenPullRequest = { url: string; branch: string; state: string; optimization_ids: number[] }

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
