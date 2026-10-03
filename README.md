# Keygrip Claude Code mods

The Claude Code plugin marketplace for Keygrip clients. **Setup guide: https://app.keygrip.ai/mods/**

| Mod | What it does |
|---|---|
| `workorder-pane` | `/workorders` opens a pane with your project's deploy queue; pick an order to read its fields, edits, schema and verify steps, and see the page rendered before and after the edits. |

```
claude plugin marketplace add KeygripGit/claude-mods
claude plugin install workorder-pane@keygrip
```

Then type `/workorders` and paste your project's client key into the pane when it asks.

This repository is a publish target: the source of truth is `app/mods/<mod>/` in the `keygrip`
monorepo, and `bin/publish-mods` there copies it here on each version bump.
