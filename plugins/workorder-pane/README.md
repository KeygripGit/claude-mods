# workorder-pane — Keygrip work orders inside Claude Code

A Claude Code **mod** (a plugin of function hooks, see `docs/claude-code-mods.md`) that draws the
client deploy loop in a pane instead of a wall of markdown in a tool row. Tracks issue #1516.

```
/workorders          # the queue: every work order the connected project has
/workorders 502      # straight to one order by optimization id
```

## What it draws

**Queue.** One row per work order from `kg_workorders`: id, version, mode, state, keyword.
Blocked rows are dimmed and refuse to open (the server refuses them too). Above the rows, the **open pull request** approved pages go into (#1855: one PR per batch in the client's own repo, reported by their agent with `kg_pull_request`); an approved page already in a PR reads `in PR`. The queue is fetched from the server every time the pane opens and every time you go back to it (nothing from an earlier open is shown as current); a row with no keyword (an order made from a URL) is named by its slug. `r` refresh,
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
| 7 Preview | the page rendered **on the server** by `kg_workorder_preview` (the first slice starts rendering the moment an order is opened, so the tab usually draws at once): `p` toggles **live** (as served now) and **proposed** (the work order's edits applied in the browser, removals marked with a dashed red rule; the web page the link opens shows the page alone under a header, and an edit the preview cannot apply marks the work order stale for staff instead of appearing on the page); `n`/`u` move through 1600 px slices, `r` re-renders. Terminal: pixels (kitty/Ghostty). Desktop/VS Code: a half-scale JPEG inside an Svg, plus a link to the same preview as a page on app.keygrip.ai. A **net-new** page (no live URL yet) is shown on a **template**: a live page of the same site — the server picks the inventory page nearest the new URL's path, and a **Template URL** field under the picture swaps in any other live page on the site. **live** is the template as served; **proposed** is the template with its article thrown out and the work order's body, H1 and hero in its place, so the new page appears in the site's own layout |

Under the tabs, an **Approve for publishing** button (`a`) calls `kg_workorder_approve`; on an
approved order it becomes **Withdraw approval**. The queue's state column reads `approved` for a
stamped row (`ready` is a row nobody has signed off; `deployed` outranks both). The stamp is per
version — an edit makes a new, unapproved version — and it is what a publishing step will read
(#1518). **Editing** is not done in the pane: the reader says so and points at the loop — tell
Claude what to change, it calls `kg_fetch_body` → `kg_save_version` on the client server
(configure that server in the session, see below), and the new version appears in the queue.

At the bottom, a **Live URL** field whose submit calls `kg_report_deployed` with `target: manual`.
It refuses an empty URL. Nothing else in the mod writes.

## Installing it (clients, and anyone outside the monorepo)

The client path is the **public GitHub marketplace `KeygripGit/claude-mods`**, published from
this folder by `bin/publish-mods` (bump `version` first). The desktop app's plugin browser lists
git-hosted marketplaces and showed nothing for a URL-hosted one (measured 2026-10-03), so the
guide — **`/mods/`** on the app, Desktop and Terminal sections — uses the repo for both:

```
claude plugin marketplace add KeygripGit/claude-mods
claude plugin install workorder-pane@keygrip
```

The app also serves this folder as a marketplace (`web/mods.py`: `GET /mods/marketplace.json`
with `archive` sources, `GET /mods/<name>-<version>.zip` built on demand, deterministic,
sha256 in the manifest) under the name **`keygrip-app`** — the no-git fallback for a terminal.
The two names differ on purpose: the engine refuses to add a marketplace whose name is already
declared with another source, with a plain "Failed to add marketplace" in the desktop app.

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
    "mcp__keygrip-workorder__kg_workorder_preview",
    "mcp__keygrip-workorder__kg_fetch_body"
  ] }
}
```

(For a marketplace install the server is `plugin_workorder-pane_keygrip-workorder` in those rules.)
The `allow` list matters in **Auto** permission mode only for the *developer* path above, where
the tools come from a hand-configured server: the pane's MCP calls come from a button, not
a prompt, so the auto-mode classifier has nothing to match them against and refuses them
("the request that produced this action did not ask for one"). Allowed tools skip the classifier.
The write tools (`kg_report_deployed`, `kg_workorder_approve`, `kg_save_version`,
`kg_restore_version`) are deliberately not allowed; switch the session off Auto, or approve the
prompt, when you report a deploy or approve from the pane, or ask Claude to edit a page.

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
screenshots the page in 1280×1600 slices. A net-new page has no live URL, so the browser loads
a **template** instead — `template_url` (a live page on the same site; anything off the site
is refused) or the inventory page nearest the new URL's path — and in `proposed` mode finds
the template's content column, removes the article from its first text block onward (the H1,
byline and hero above it stay), appends the work order's body there, and swaps in the new H1,
hero and title. The metadata then carries `template_url` and `page_url` beside `url`. One call returns one slice as an image block plus a
JSON block (`slices`, `height`, `applied` per edit, `view_url`). Renders are cached ten
minutes per (run, version, mode) in the web process. The web twin is
`…/studio/runs/<id>/preview/?mode=proposed`, which shows the page alone under a header, as a
live document (the render's DOM, scripts stripped, in a sandboxed frame) rather than slices (an
edit the preview cannot apply marks the work order stale rather than appearing on the page);
that is the `view_url` the desktop pane links to.

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
- A shared render cache (R2 or Postgres) if the per-process one proves too cold across the
  two web boxes.
