# Decisions

## 2026-11-25 — One Node script instead of the bash push scripts

Before: The source project pushed cards with `push-card.sh` and dashboards with `push-dashboard.sh` (bash + jq),
and a later project copied the idea into its own `push.sh` with different placeholder rules.
Decision: Ship one tool, `skills/metabase-as-code/scripts/mbac.mjs`, written in Node with no dependencies, that pushes
cards, models, dashboards and collections.
Reason: `mb` itself needs Node 20.6+, so Node is present wherever the skill can work; bash needs jq on top. JSON
handling (placeholder walks, dependency order, diff projection) is clearer in JS than in jq strings, and the tool can
be tested with `node --test` against a fake `mb` (9 tests). shellcheck is not installed here, so a bash version could
not be linted. Two scripts with two placeholder dialects are what made agents reinvent a third.

## 2026-11-25 — Ids per profile in ids/\<profile\>.json, not inside each definition

Before: Each definition json held its production `id`; the local environment kept a separate state file, and the push
script had two code paths.
Decision: Definitions hold no ids. `mbac` writes `ids/<profile>.json` (`collections`, `items[path] = {id,
updated_at}`) for every profile, and resolves placeholders against it.
Reason: The same definitions are pushed to more than one Metabase (local and production in the source project), and
each has its own ids. One mechanism for all profiles removes the special case, and keeps a single place to adopt
existing content by hand.

## 2026-11-25 — Refuse to overwrite items edited in Metabase since the last push

Before: The rule "pull UI edits back before changing anything" lived only in CLAUDE.md; nothing checked it.
Decision: After each push `mbac` records Metabase's `updated_at`. Before an update it compares that with the current
value and refuses on a mismatch unless `--force`; `mbac diff` shows the repo and Metabase side by side.
Reason: The rule was easy to skip. Checked live on Metabase 0.61.3: running a card (`mb card query`) and reading a
dashboard do not change `updated_at`, and an edit through the API does, so the check does not fire on views and does
fire on edits.

## 2026-11-25 — Placeholder grammar

Before: The source project used `"@database"` and `"@metabase/<path>.json"`; the later project used `"@card:<name>"`,
`"@dashboard:<name>"`, `"@db"`, `"@table:"`, `"@field:"` and `@@...@@` for ids inside strings.
Decision: `"@database"`, `"@card:<path>"`, `"@dashboard:<path>"`, `"@collection:<key>"`, `"@table:[schema.]table"`,
`"@field:[schema.]table.column"`; `@@<same>@@` splices an id into a longer string or a .sql file. Paths are relative
to the content root.
Reason: Paths instead of bare names allow the same file name in `cards/` and `models/`. Table and field lookups by
name were needed when a database was recreated and its field ids changed. The embedded form is needed for links in text
cards and model references in native SQL.
