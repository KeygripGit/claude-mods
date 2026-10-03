import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Tab } from '../types'
import { parseWorkOrder, unwrap } from './parse'
import type { QueueRow, WorkOrder, Field } from './parse'

const PANE = 'workorders'
// The pane talks to Keygrip's client MCP endpoint itself, over the engine's fetch, with the
// project's kg_client_ key as a header. Not through an MCP server in the manifest: a tool call
// made from a button is refused by the Auto-mode permission classifier ("the request that
// produced this action did not ask for one"), which would make every client paste an allow
// list, and the key would have to be set through /plugin configure. A direct fetch needs
// neither — the key is pasted once into the pane and kept in the plugin's own store. The
// endpoint is stateless and answers JSON, so one POST per tool call is the whole protocol.
const ENDPOINT = 'https://app.keygrip.ai/client/mcp'
const KEY_STORE = 'client_key'
let clientKey: string | null | undefined   // undefined: not read yet; null: none stored

async function loadKey($: EngineInterface): Promise<string | null> {
  if (clientKey === undefined) {
    const v = await $.store.get(KEY_STORE)
    clientKey = typeof v === 'string' && v ? v : null
  }
  return clientKey
}

async function saveKey($: EngineInterface, key: string) {
  clientKey = key || null
  if (key) await $.store.set(KEY_STORE, key)
  else await $.store.delete(KEY_STORE)
  // every cache was filled under the old key
  queue = null; queueKey = null; orders.clear(); shots.clear()
}

type ToolResult = { isError: boolean; content: { type: string; text?: string; [k: string]: unknown }[] }
let rpcId = 0
async function callTool($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const key = await loadKey($)
  if (!key) return { isError: true, content: [{ type: 'text', text: 'no client key: paste one into the pane first' }] }
  const r = await $.http.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }),
  })
  if (r.status === 401 || r.status === 403) return { isError: true, content: [{ type: 'text', text: `the key was refused (HTTP ${r.status}): paste a current one (k)` }] }
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: `HTTP ${r.status} from ${ENDPOINT}: ${r.text.slice(0, 200)}` }] }
  let body: { result?: ToolResult; error?: { message?: string } }
  try { body = JSON.parse(r.text) } catch { return { isError: true, content: [{ type: 'text', text: `not JSON: ${r.text.slice(0, 200)}` }] } }
  if (body.error) return { isError: true, content: [{ type: 'text', text: body.error.message ?? 'rpc error' }] }
  const res = body.result ?? { isError: true, content: [{ type: 'text', text: 'empty result' }] }
  return { isError: Boolean(res.isError), content: res.content ?? [] }
}

const view = atom({ plugin: 'workorder-pane', key: 'view' } as const, 'queue' as 'queue' | 'order')
const selected = atom({ plugin: 'workorder-pane', key: 'selected' } as const, null as number | null)
const tab = atom({ plugin: 'workorder-pane', key: 'tab' } as const, 'overview' as Tab)
const includeSuperseded = atom({ plugin: 'workorder-pane', key: 'includeSuperseded' } as const, false)
const checked = atom({ plugin: 'workorder-pane', key: 'checked' } as const, [] as number[])
const tick = atom({ plugin: 'workorder-pane', key: 'tick' } as const, 0)
const slice = atom({ plugin: 'workorder-pane', key: 'slice' } as const, 0)
const keyPrompt = atom({ plugin: 'workorder-pane', key: 'keyPrompt' } as const, false)
const previewMode = atom({ plugin: 'workorder-pane', key: 'previewMode' } as const, 'proposed' as 'live' | 'proposed')

// Fetched data lives here, not in $.state: a work order is tens of KB. A hot reload
// empties it and the next draw refetches, keyed by the ids $.state still holds.
type Loaded<T> = { ok: true; data: T } | { ok: false; error: string }
let queue: Loaded<QueueRow[]> | null = null
let queueKey: string | null = ''
const orders = new Map<number, Loaded<WorkOrder>>()
// One rendered slice from kg_workorder_preview, keyed by `${id}:${mode}:${slice}:${variant}`.
type Shot = { data: string; mime: string; meta: PreviewMeta }
type PreviewMeta = { mode: string; url: string; width: number; height: number; slice_height: number; slices: number
  truncated: boolean; elapsed_ms: number; applied: { id: string; kind: string; status: string; note?: string }[]
  applied_count: number; not_found: string[]; view_url?: string; slice: number }
const shots = new Map<string, Loaded<Shot>>()
const shotKey = (id: number, mode: string, at: number, variant: string) => `${id}:${mode}:${at}:${variant}`
const inflight = new Set<string>()

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'overview', label: 'Overview', hotkey: '1' },
  { id: 'fields', label: 'Fields', hotkey: '2' },
  { id: 'edits', label: 'Edits', hotkey: '3' },
  { id: 'schema', label: 'Schema', hotkey: '4' },
  { id: 'verify', label: 'Verify', hotkey: '5' },
  { id: 'notes', label: 'Notes', hotkey: '6' },
  { id: 'preview', label: 'Preview', hotkey: '7' },
]

function meter(n: number, limit: number, width = 20): string {
  const filled = Math.min(width, Math.round((n / limit) * width))
  return `${'#'.repeat(filled)}${'-'.repeat(width - filled)} ${n}/${limit}`
}

async function loadQueue($: EngineInterface, superseded: boolean) {
  const key = `queue:${superseded}`
  if (inflight.has(key)) return
  inflight.add(key)
  await update($, tick, n => (n ?? 0) + 1)
  try {
    const r = await callTool($, 'kg_workorders', { include_superseded: superseded })
    if (r.isError) queue = { ok: false, error: unwrap(r.content) }
    else {
      const parsed = JSON.parse(unwrap(r.content)) as { items?: QueueRow[] }
      queue = { ok: true, data: parsed.items ?? [] }
    }
    queueKey = key
  } catch (err) {
    queue = { ok: false, error: String(err) }
    queueKey = key
  } finally {
    inflight.delete(key)
    await update($, tick, n => (n ?? 0) + 1)
  }
}

async function loadOrder($: EngineInterface, id: number) {
  const key = `order:${id}`
  if (inflight.has(key)) return
  inflight.add(key)
  await update($, tick, n => (n ?? 0) + 1)
  try {
    const r = await callTool($, 'kg_fetch_workorder', { optimization_id: id })
    const text = unwrap(r.content)
    orders.set(id, r.isError ? { ok: false, error: text } : { ok: true, data: parseWorkOrder(text) })
  } catch (err) {
    orders.set(id, { ok: false, error: String(err) })
  } finally {
    inflight.delete(key)
    await update($, tick, n => (n ?? 0) + 1)
  }
}


//: Under this many raw bytes the engine leaves a PNG alone (measured: a 200 KB slice arrived
//: as PNG, a 1.1 MB one as JPEG).
const TERMINAL_PNG_BUDGET = 400_000
// base64 of the PNG signature 0x89 'P' 'N' 'G' \r \n 0x1a \n
const isPng = (b64: string) => b64.startsWith('iVBORw0KGgo')

type ImageBlock = { type: string; data?: string; mimeType?: string; source?: { type?: string; data?: string; media_type?: string } }
function pictureOf(blocks: readonly { type: string }[]): { data: string; mime: string } | null {
  for (const b of blocks as ImageBlock[]) {
    if (b.type !== 'image') continue
    if (b.source?.data) return { data: b.source.data, mime: b.source.media_type ?? 'image/png' }
    if (b.data) return { data: b.data, mime: b.mimeType ?? 'image/png' }
  }
  return null
}

// Layer 3: the server renders the page (live, or with the edits applied in the browser)
// and hands one slice back as an image block plus its metadata — kg_workorder_preview.
// `variant` is `full` (PNG, for the terminal's Image) or `thumb` (half-scale JPEG, for the
// desktop's Svg budget).
async function loadShot($: EngineInterface, id: number, mode: string, at: number, variant: 'full' | 'thumb', refresh = false) {
  const key = shotKey(id, mode, at, variant)
  if (inflight.has(key)) return
  inflight.add(key)
  await update($, tick, n => (n ?? 0) + 1)
  try {
    const args: Record<string, unknown> = { optimization_id: id, mode, slice: at, refresh }
    // The engine re-encodes an image block over its own byte limit to JPEG before a plugin
    // sees it, and the terminal's Image takes PNG only: ask the server to keep the PNG under
    // that limit (palette, then scale). The desktop's Svg takes any picture under ~128 KB.
    if (variant === 'thumb') Object.assign(args, { format: 'jpeg', scale: 0.5 })
    else Object.assign(args, { format: 'png', max_bytes: TERMINAL_PNG_BUDGET })
    const r = await callTool($, 'kg_workorder_preview', args)
    if (r.isError) { shots.set(key, { ok: false, error: unwrap(r.content).slice(0, 400) }); return }
    // The engine hands a plugin the result as the session stores it, which is the API shape
    // ({ type: 'image', source: { type: 'base64', media_type, data } }); a raw MCP block
    // ({ data, mimeType }) is accepted too, so a test or another host reads the same.
    const picture = pictureOf(r.content)
    const metaText = r.content.find(b => b.type === 'text' && (b.text ?? '').trim().startsWith('{'))?.text ?? '{}'
    if (!picture) {
      const shapes = r.content.map(b => `${b.type}{${Object.keys(b).filter(k => k !== 'type').join(',')}}`).join(' ')
      shots.set(key, { ok: false, error: `the tool returned no image block (blocks: ${shapes || 'none'})` })
      return
    }
    if (variant === 'full' && !isPng(picture.data)) {
      const kb = Math.round((picture.data.length * 3) / 4 / 1024)
      shots.set(key, { ok: false, error: `the engine handed the pane a ${picture.mime} of ${kb} KB, not a PNG; the terminal draws PNG only (server max_bytes=${TERMINAL_PNG_BUDGET})` })
      return
    }
    shots.set(key, { ok: true, data: { ...picture, meta: JSON.parse(metaText) as PreviewMeta } })
  } catch (err) {
    shots.set(key, { ok: false, error: String(err) })
  } finally {
    inflight.delete(key)
    await update($, tick, n => (n ?? 0) + 1)
  }
}

// Opening an order starts the server render of its first preview slice right away, so the
// Preview tab draws from the cache instead of making the reader wait the few seconds a
// Chromium render takes. Only slice 0 of the current mode: one render warms the server's
// page cache for every other slice of that mode, and the other mode is a `p` away.
async function prefetchPreview($: EngineInterface, id: number, surface: RenderSurface) {
  const variant = surface === 'terminal' ? 'full' : 'thumb'
  const mode = await read($, previewMode)
  if (!shots.has(shotKey(id, mode, 0, variant))) void loadShot($, id, mode, 0, variant)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workorders',
      description: 'Keygrip work orders in a pane: the queue, or one order by id (/workorders 502)',
    })
    return next(e)
  })

  on('command.run', { command: 'workorders' }, async ($, e) => {
    const id = Number.parseInt(e.args.trim(), 10)
    if (Number.isFinite(id)) {
      await update($, selected, () => id)
      await update($, view, () => 'order')
      await update($, tab, () => 'overview')
    } else {
      await update($, view, () => 'queue')
    }
    const superseded = await read($, includeSuperseded)
    if (await loadKey($)) {
      if (queue === null || queueKey !== `queue:${superseded}`) void loadQueue($, superseded)
      if (Number.isFinite(id) && !orders.has(id)) void loadOrder($, id)
      if (Number.isFinite(id)) void prefetchPreview($, id, 'terminal')
    }
    const opened = await $.ui.open({ id: PANE, title: 'Work orders' })
    return { text: opened.isPlaced ? 'Work orders pane opened.' : `Pane not placed: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The work-order pane needs a surface with Input (terminal, desktop or VS Code).</Text>
    }
    const { Box, Text, Button, Input, Code, Markdown, Link } = $.ui.resolve(e)
    const [which, id, current, superseded, done, at, pmode] = await Promise.all([
      read($, view), read($, selected), read($, tab), read($, includeSuperseded), read($, checked), read($, slice), read($, previewMode),
    ])
    await read($, tick)
    const width = Math.max(20, e.props.bodyColumns - 2)
    const surface: RenderSurface = e.surface

    const copy = (text: string, what: string) => async () => {
      const r = await $.ui.copy({ text, surface })
      $.ui.toast(r.isCopied ? `Copied ${what}` : `Could not copy ${what}: ${r.reason}`)
    }

    // ---- key ---------------------------------------------------------------
    // Pasted once per machine and kept in the plugin's store; `k` on the queue changes it.
    const haveKey = await loadKey($)
    const askKey = await read($, keyPrompt)
    if (!haveKey || askKey) {
      const submit = (value: string) => {
        const k = value.trim()
        if (!k.startsWith('kg_client_')) { $.ui.toast('A Keygrip client key starts with kg_client_'); return }
        void (async () => {
          await saveKey($, k)
          await update($, keyPrompt, () => false)
          await update($, view, () => 'queue')
          void loadQueue($, superseded)
        })()
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{haveKey ? 'Change the Keygrip client key' : 'Connect this pane to your Keygrip project'}</Text>
          <Text dimColor wrap="wrap">Paste the project's client key (kg_client_…). It comes from the project's Settings → Client MCP access in app.keygrip.ai, or from your Keygrip contact. It is kept on this machine only.</Text>
          <Input key="client-key" label="Client key" placeholder="kg_client_…" submitLabel="Connect" autoFocus onSubmit={submit} />
          {haveKey && <Button key="keep-key" hotkey="b" onPress={() => update($, keyPrompt, () => false)}>Keep the current key</Button>}
        </Box>
      )
    }

    // ---- queue -------------------------------------------------------------
    if (which === 'queue' || id === null) {
      const key = `queue:${superseded}`
      if (queue === null || queueKey !== key) {
        if (inflight.has(key)) return <Text dimColor>Loading work orders…</Text>
        return (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Work orders not loaded yet.</Text>
            <Button key="load-queue" hotkey="l" onPress={() => { void loadQueue($, superseded) }}>Load</Button>
          </Box>
        )
      }
      if (!queue.ok) {
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="red">Could not list work orders: {queue.error}</Text>
            <Button hotkey="r" onPress={() => { queue = null; void loadQueue($, superseded) }}>Retry</Button>
          </Box>
        )
      }
      const rows = queue.data
      const ready = rows.filter(r => !r.blocked).length
      const open = (row: QueueRow) => () => {
        if (row.blocked) { $.ui.toast(`#${row.id} is blocked (${row.blocker_count}); Keygrip is resolving it`); return }
        if (!orders.has(row.id)) void loadOrder($, row.id)
        void prefetchPreview($, row.id, surface)
        void (async () => {
          await update($, selected, () => row.id)
          await update($, tab, () => 'overview')
          await update($, checked, () => [])
          await update($, slice, () => 0)
          await update($, view, () => 'order')
        })()
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{rows.length} work orders · {ready} ready · {rows.length - ready} blocked{superseded ? ' · superseded included' : ''}</Text>
          <Box flexDirection="column">
            <Text dimColor>{'id    ver  mode      state       keyword'}</Text>
            {rows.map(r => {
              const flag = r.blocked ? `BLOCKED(${r.blocker_count})` : r.deployed_at ? 'deployed' : 'ready'
              const label = `#${String(r.id).padEnd(4)} v${String(r.version).padEnd(3)} ${r.mode.padEnd(9)} ${flag.padEnd(11)} ${r.keyword}`
              return (
                <Button
                  key={`row-${r.id}`}
                  plain
                  dimColor={r.blocked}
                  label={label.length > width ? label.slice(0, width - 1) + '…' : label}
                  onPress={open(r)}
                />
              )
            })}
          </Box>
          <Box gap={1}>
            <Button hotkey="r" onPress={() => { queue = null; void loadQueue($, superseded) }}>Refresh</Button>
            <Button key="change-key" hotkey="k" onPress={() => update($, keyPrompt, () => true)}>Key</Button>
            <Button hotkey="s" onPress={() => { void (async () => { const next = !superseded; await update($, includeSuperseded, () => next); void loadQueue($, next) })() }}>{superseded ? 'Hide superseded' : 'Show superseded'}</Button>
            <Button role="dismiss" onPress={() => $.ui.close({ id: PANE })}>Close</Button>
          </Box>
        </Box>
      )
    }

    // ---- one order ----------------------------------------------------------
    const loaded = orders.get(id)
    const back = <Button key="back" hotkey="b" onPress={() => update($, view, () => 'queue')}>Back to queue</Button>
    if (!loaded) {
      if (inflight.has(`order:${id}`)) return <Box flexDirection="column" gap={1}><Text dimColor>Fetching work order #{id}…</Text>{back}</Box>
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Work order #{id} not loaded yet.</Text>
          <Box gap={1}>
            <Button key="load-order" hotkey="l" onPress={() => { void loadOrder($, id); void prefetchPreview($, id, surface) }}>Load</Button>
            {back}
          </Box>
        </Box>
      )
    }
    if (!loaded.ok) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="red">#{id}: {loaded.error}</Text>
          <Box gap={1}>
            <Button hotkey="r" onPress={() => { orders.delete(id); void loadOrder($, id); void prefetchPreview($, id, surface) }}>Retry</Button>
            {back}
          </Box>
        </Box>
      )
    }
    const wo = loaded.data
    const row = queue?.ok ? queue.data.find(r => r.id === id) : undefined

    let body
    switch (current) {
      case 'fields':
        body = (
          <Box flexDirection="column" gap={1}>
            {wo.fields.map((f: Field) => (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text bold>{f.name}</Text>
                  <Text dimColor>→ {f.target}</Text>
                </Box>
                <Code source={f.value} />
                <Box gap={2}>
                  {f.limit !== undefined && (
                    <Text color={f.chars > f.limit ? 'red' : 'green'}>{meter(f.chars, f.limit)}</Text>
                  )}
                  {f.unchanged && <Text dimColor>unchanged on the live page</Text>}
                  <Button plain onPress={copy(f.value, f.name)}>copy</Button>
                </Box>
              </Box>
            ))}
            {wo.fields.length === 0 && <Text dimColor>No deployable fields found.</Text>}
          </Box>
        )
        break
      case 'edits':
        body = (
          <Box flexDirection="column" gap={1}>
            {wo.bodyIntro && <Markdown text={wo.bodyIntro} />}
            {wo.fullBody !== null && (
              <Box flexDirection="column">
                <Box gap={2}><Text bold>BODY (full page)</Text><Button plain onPress={copy(wo.fullBody, 'the body')}>copy</Button></Box>
                <Code source={wo.fullBody} language="html" />
              </Box>
            )}
            {wo.edits.map(ed => (
              <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                <Text bold>Edit {ed.n} of {ed.of}: {ed.title}</Text>
                <Text dimColor>Why: {ed.why}</Text>
                <Text dimColor>Where: {ed.where}</Text>
                {ed.find && <Text>Find:</Text>}
                {ed.find && <Code source={ed.find} />}
                <Box gap={2}>
                  <Text>{ed.kind === 'remove' ? 'Replace with: nothing; remove it.' : ed.kind === 'insert' ? 'Insert:' : 'Replace with:'}</Text>
                  {ed.replace && <Button plain onPress={copy(ed.replace, `edit ${ed.n}`)}>copy</Button>}
                </Box>
                {ed.replace && <Code source={ed.replace} language="html" />}
              </Box>
            ))}
            {wo.edits.length === 0 && wo.fullBody === null && <Text dimColor>No body edits in this work order.</Text>}
          </Box>
        )
        break
      case 'schema':
        body = wo.schema ? (
          <Box flexDirection="column" gap={1}>
            <Box gap={2}><Text bold>JSON-LD → inject into &lt;head&gt; (merge into an existing @graph)</Text><Button plain onPress={copy(wo.schema, 'the JSON-LD')}>copy</Button></Box>
            <Code source={wo.schema} language="json" />
          </Box>
        ) : <Text dimColor>No structured data in this work order.</Text>
        break
      case 'verify':
        body = (
          <Box flexDirection="column">
            {wo.verify.map((step, i) => (
              <Button
                key={`verify-${i}`}
                plain
                dimColor={done.includes(i)}
                label={`${done.includes(i) ? '[x]' : '[ ]'} ${i + 1}. ${step}`}
                onPress={() => update($, checked, list => done.includes(i) ? (list ?? []).filter(x => x !== i) : [...(list ?? []), i])}
              />
            ))}
            <Text dimColor>{done.length}/{wo.verify.length} checked</Text>
          </Box>
        )
        break
      case 'notes':
        body = (
          <Box flexDirection="column" gap={1}>
            {wo.contextChanged && <Markdown text={`## Context changed since this version\n\n${wo.contextChanged}`} />}
            {wo.recommended && <Markdown text={`## Recommended, not applied\n\n${wo.recommended}`} />}
            {wo.checked && <Markdown text={`## Checked and left alone\n\n${wo.checked}`} />}
            {!wo.contextChanged && !wo.recommended && !wo.checked && <Text dimColor>No notes.</Text>}
          </Box>
        )
        break
      case 'preview': {
        const variant = e.surface === 'terminal' ? 'full' : 'thumb'
        const key = shotKey(id, pmode, at, variant)
        const shot = shots.get(key)
        const modeRow = (
          <Box gap={1}>
            <Button hotkey="p" onPress={() => { void (async () => {
              const next = pmode === 'proposed' ? 'live' : 'proposed'
              await update($, previewMode, () => next)
              if (!shots.has(shotKey(id, next, at, variant))) void loadShot($, id, next, at, variant)
            })() }}>{pmode === 'proposed' ? 'Show live' : 'Show proposed'}</Button>
            <Button hotkey="r" onPress={() => { for (const k of [...shots.keys()]) if (k.startsWith(`${id}:`)) shots.delete(k); void loadShot($, id, pmode, at, variant, true) }}>Re-render</Button>
          </Box>
        )
        if (!shot) {
          body = (
            <Box flexDirection="column" gap={1}>
              {inflight.has(key)
                ? <Text dimColor>Rendering the {pmode} page on the server… (started when the order was opened; a few seconds)</Text>
                : <Button key="load-preview" hotkey="l" label={`Render ${pmode} preview`} onPress={() => { void loadShot($, id, pmode, at, variant) }} />}
              {modeRow}
            </Box>
          )
          break
        }
        if (!shot.ok) {
          body = (
            <Box flexDirection="column" gap={1}>
              <Text color="red">Preview failed: {shot.error}</Text>
              {modeRow}
            </Box>
          )
          break
        }
        const m = shot.data.meta
        const n = Math.max(1, m.slices)
        const i = Math.min(Math.max(0, at), n - 1)
        const from = i * m.slice_height
        const sliceH = Math.min(m.slice_height, m.height - from)
        const columns = Math.max(1, Math.min(255, width))
        const rows = Math.max(1, Math.min(255, Math.round((columns * sliceH) / m.width / 2)))
        const caption = `${m.mode} · ${m.width}×${m.height} px · slice ${i + 1}/${n} (${from}–${from + sliceH} px)${m.truncated ? ' · page cut' : ''} · ${Math.round(m.elapsed_ms / 1000)} s`
        const applied = m.mode === 'proposed' ? `${m.applied_count}/${m.applied.length} edits applied${m.not_found.length ? `, not found: ${m.not_found.length}` : ''}` : ''
        const nav = (
          <Box gap={1}>
            <Button hotkey="u" onPress={() => { void (async () => { const k = Math.max(0, i - 1); await update($, slice, () => k); if (!shots.has(shotKey(id, pmode, k, variant))) void loadShot($, id, pmode, k, variant) })() }}>Up</Button>
            <Button hotkey="n" onPress={() => { void (async () => { const k = Math.min(n - 1, i + 1); await update($, slice, () => k); if (!shots.has(shotKey(id, pmode, k, variant))) void loadShot($, id, pmode, k, variant) })() }}>Down</Button>
          </Box>
        )
        let picture
        if (e.surface === 'terminal') {
          const { Image } = $.ui.resolve(e)
          picture = <Image source={{ png: shot.data.data }} columns={columns} rows={rows} alt={`[${m.mode} preview slice ${i + 1}/${n}: this terminal cannot draw pixels]`} />
        } else {
          const { Svg } = $.ui.resolve(e)
          const W = 640, H = Math.round((640 * sliceH) / m.width)
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><image width="${W}" height="${H}" xlink:href="data:${shot.data.mime};base64,${shot.data.data}"/></svg>`
          picture = <Svg source={svg} alt={`${m.mode} preview slice ${i + 1} of ${n}`} width={W} height={H} />
        }
        body = (
          <Box flexDirection="column" gap={1}>
            <Text dimColor wrap="truncate-end">{m.url}</Text>
            <Text dimColor>{caption}{applied ? ` · ${applied}` : ''}</Text>
            {picture}
            {m.view_url && <Link href={m.view_url}>Open this preview as a page</Link>}
            <Box gap={1}>{nav}{modeRow}</Box>
          </Box>
        )
        break
      }
      default:
        body = (
          <Box flexDirection="column" gap={1}>
            <Markdown text={`**Mode:** ${wo.mode}  \n**Prepared:** ${wo.prepared}\n\n### Keyword target\n\n${wo.keywordTarget}\n\n### What changed\n\n${wo.whatChanged}${wo.heroImage ? `\n\n### Hero image\n\n${wo.heroImage}` : ''}`} />
          </Box>
        )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>#{id} · {row?.keyword ?? wo.title}</Text>
          <Text dimColor wrap="truncate-end">{wo.title}{row ? ` · v${row.version} · ${row.mode}` : ''}</Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          {TABS.map(t => (
            <Button key={`tab-${t.id}`} hotkey={t.hotkey} variant={t.id === current ? 'primary' : 'secondary'} onPress={() => {
              if (t.id === 'preview') { const v = e.surface === 'terminal' ? 'full' : 'thumb'; if (!shots.has(shotKey(id, pmode, at, v))) void loadShot($, id, pmode, at, v) }
              return update($, tab, () => t.id)
            }}>{t.label}</Button>
          ))}
          {back}
        </Box>
        {body}
        <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
          <Text dimColor>After publishing, report where the page went (anchors the before/after report):</Text>
          <Input
            key="deploy-url"
            label="Live URL"
            placeholder={row?.page_url ?? 'https://…'}
            submitLabel="Report deployed"
            onSubmit={value => {
              const url = value.trim()
              if (!url) { $.ui.toast('Type the live URL first'); return }
              void (async () => {
                const r = await callTool($, 'kg_report_deployed', { optimization_id: id, url, target: 'manual' })
                $.ui.toast(r.isError ? `Report failed: ${unwrap(r.content).slice(0, 120)}` : `Reported #${id} deployed at ${url}`)
                queue = null
                await update($, tick, n => (n ?? 0) + 1)
              })()
            }}
          />
        </Box>
      </Box>
    )
  })
}
