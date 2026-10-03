# workorder-pane — Keygrip work orders inside Claude Code

A Claude Code **mod** (a plugin of function hooks, see `docs/claude-code-mods.md`) that draws the
client deploy loop in a pane instead of a wall of markdown in a tool row. Tracks issue #1516.

```
/workorders          # the queue: every work order the connected project has
/workorders 502      # straight to one order by optimization id
```

## What it draws

**Queue.** One row per work order from `kg_workorders`: id, version, mode, state, keyword.
Blocked rows are dimmed and refuse to open (the server refuses them too). `r` refresh,
`s` show/hide superseded versions.

**Reader** (pick a row). Fetches `kg_fetch_workorder` once and splits the document on its fixed
headings. Tabs on `1`–`7`, `b` back to the queue:

| Tab | Shows |
|---|---|
| 1 Overview | mode, prepared date, keyword target, "what changed", hero image |
| 2 Fields | each deployable value in a code block, a length meter against its SEO limit (red when over), `unchanged` when it matches the live page, a copy button |
| 3 Edits | each body edit boxed: why, where, the *Find* text and the *Replace/Insert* HTML, a copy button; a net-new order shows the full body |
| 4 Schema | the JSON-LD with the `<script>` wrapper stripped, a copy button |
| 5 Verify | the post-publish steps as toggles, with a checked count |
| 6 Notes | context changed since this version, recommended-not-applied, checked-and-left-alone |
| 7 Preview | the page rendered **on the server** by `kg_workorder_preview` (the first slice starts rendering the moment an order is opened, so the tab usually draws at once): `p` toggles **live** (as served now) and **proposed** (the work order's edits applied in the browser, each outlined in brand cyan, removals marked with a dashed red rule); `n`/`u` move through 1600 px slices, `r` re-renders. Terminal: pixels (kitty/Ghostty). Desktop/VS Code: a half-scale JPEG inside an Svg, plus a link to the same preview as a page on app.keygrip.ai |

At the bottom, a **Live URL** field whose submit calls `kg_report_deployed` with `target: manual`.
It refuses an empty URL. Nothing else in the mod writes.

## Installing it (clients, and anyone outside the monorepo)

The app serves this folder as a Claude Code plugin marketplace (`web/mods.py`, #1516):
`GET /mods/marketplace.json` lists each mod under `app/mods/` as an `archive` source and
`GET /mods/<name>-<version>.zip` is the mod zipped on demand (deterministic, cached per
process, sha256 in the manifest). Public, like `/healthz`: a client needs no GitHub account and
no git on the machine. The client-facing guide is **`/mods/`** (desktop click path, terminal
commands); the project's Client MCP access box prints the two commands and the key to paste:

```
claude plugin marketplace add https://app.keygrip.ai/mods/marketplace.json
claude plugin install workorder-pane@keygrip
```

The pane talks to `https://app.keygrip.ai/client/mcp` itself — one JSON-RPC `tools/call` POST
per tool over `$.http.fetch`, the project's `kg_client_` key as the Bearer header — and asks for
that key once, in the pane, keeping it in the plugin's own `$.store` (`k` on the queue changes
it). It deliberately does **not** declare the server in the manifest: a tool call made from a
button is refused by the Auto-mode permission classifier ("the request that produced this action
did not ask for one"), measured on the desktop with a plugin-bundled server too, which would
make every client paste an allow list; and a manifest server needs the key through `/plugin
configure`. A direct fetch needs neither — measured under `--permission-mode auto` on
2026-10-03. The endpoint is stateless and answers JSON, so there is no handshake. **Bump
`version` in `plugin.json` with every change you want installs to pick up**: an install pins to
the version it saw, `claude plugin update` only moves when the number does, and the zip URL
carries the version.

⚠️ A plugin loaded through `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` **overrides a marketplace
install of the same name** (and `claude plugin install --config` then reports "failed to load after
install"); on a developer machine use one or the other.

## Loading it from the checkout (developers)

**CLI, one session:** `claude --plugin-dir app/mods/workorder-pane`

**CLI or desktop, always:** name the folder in `CLAUDE_CODE_PLUGIN_DIRS`, in the process
environment or the `env` block of `~/.claude/settings.json` (the user file, never a project's).

**Claude Desktop on Windows** runs its own engine with its own `%USERPROFILE%\.claude`, so it
needs a Windows path. The copy that works today:

```jsonc
// C:\Users\<you>\.claude\settings.json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\.claude\\mods\\workorder-pane" },
  "permissions": { "allow": [
    "mcp__keygrip-workorder__kg_workorders",
    "mcp__keygrip-workorder__kg_fetch_workorder",
    "mcp__keygrip-workorder__kg_articles",
    "mcp__keygrip-workorder__kg_article_status",
    "mcp__keygrip-workorder__kg_workorder_preview"
  ] }
}
```

(For a marketplace install the server is `plugin_workorder-pane_keygrip-workorder` in those rules.)
The `allow` list matters in **Auto** permission mode only for the *developer* path above, where
the tools come from a hand-configured server: the pane's MCP calls come from a button, not
a prompt, so the auto-mode classifier has nothing to match them against and refuses them
("the request that produced this action did not ask for one"). Allowed tools skip the classifier.
The write tool `kg_report_deployed` is deliberately not allowed; switch the session off Auto, or
approve the prompt, when you report a deploy from the pane.

Sync the Windows copy from WSL after a change:

```bash
rsync -a --delete --exclude .cache --exclude '.claude-plugin/types' --exclude tsconfig.json \
  app/mods/workorder-pane/ /mnt/c/Users/<you>/.claude/mods/workorder-pane/
```

## The MCP server it talks to

`keygrip-workorder` → `https://app.keygrip.ai/client/mcp` with a project-scoped `kg_client_` key
(`claude mcp add --transport http keygrip-workorder <url> -H "Authorization: Bearer kg_client_…"`).
The server name is what `$.mcp.call` is given; the desktop app needs the same server in **its**
`.claude.json`. Minting the key: project settings in the app (issue #1071).

## How the preview is made

Nothing runs on the laptop. `kg_workorder_preview(optimization_id, mode, slice, format, scale)`
on the client MCP server (and the same tool on the internal `/mcp`) calls
`GET /api/v1/optimizations/{id}/preview`, which `content/page_preview.py` serves: the app
image's own Chromium loads the run's `page_url`, and in `proposed` mode runs the work order's
`BodyEdit`s against the live DOM by the same rules a person follows in the CMS editor (find by
meaning, a section runs to the next heading of the same level, edits apply in order), then
screenshots the page in 1280×1600 slices. One call returns one slice as an image block plus a
JSON block (`slices`, `height`, `applied` per edit, `view_url`). Renders are cached ten
minutes per (run, version, mode) in the web process. The web twin is
`…/studio/runs/<id>/preview/?mode=proposed`, which stacks every slice and lists each edit's
outcome; that is the `view_url` the desktop pane links to.

Pixels in the terminal still need kitty ≥ 0.28 or Ghostty (see `docs/claude-code-mods.md`).

## Developing

```bash
claude plugin validate app/mods/workorder-pane   # manifest + what the module hooks/calls
claude plugin test     app/mods/workorder-pane   # hooks/*.test.tsx against the engine
```

The parser (`hooks/parse.ts`) keys on the document's headings; `hooks/fixture.ts` is a compact
work order in that shape, modelled on optimization 502. Rules the validator enforces that cost a
round each: `$` may only be passed to a top-level function declaration; `atom()` references need
literal plugin strings; a Button takes one string child or `label`; a fetch must start from a
command or button handler, never from the render hook (a write from the draw's async chain is
dropped silently).

## Not built

- Structured JSON from the server beside the markdown, so the heading parser can go.
- A `proposed` render for a net-new page (no live URL yet): render the body in Keygrip's own
  preview template instead.
- A shared render cache (R2 or Postgres) if the per-process one proves too cold across the
  two web boxes.
