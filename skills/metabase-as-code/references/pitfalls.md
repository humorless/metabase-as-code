# Things that fail silently

Collected from real projects. Each item says what happens and what to do. Versions: mb CLI 0.5.7,
Metabase 0.61–0.63 (open source) and 1.63 (Enterprise).

## Connection

- **`mb` prefers `MB_URL` / `MB_API_KEY` over `--profile`.** A shell that still holds production
  values sends a "local" push to production; this has happened. `mbac` removes both variables
  before every `mb` call. When you run read-only `mb` commands yourself, prefix them with
  `env -u MB_URL -u MB_API_KEY`.
- **`mb` cuts output at 24 KB by default.** Cards with many columns come back truncated. Add
  `--max-bytes 0` to `mb card get --full` and similar calls (`mbac` does).

## Cards and models

- **A native card created through the API has `result_metadata: null` until it runs once**, so
  column descriptions have nowhere to go. `mbac` runs the card once when that happens.
- **Column names are as the database returns them.** H2 (Sample Database) and Snowflake upper-case
  unquoted aliases, so `columns` keys must be `ORDER_MONTH`, not `order_month`. `mbac` warns
  about keys the query does not return.
- **Words such as `month` are reserved in H2**; alias them (`order_month`).
- **A model's SQL runs as a subquery when a question builds on it.** `GROUP BY 1` worked in the
  model and failed in the question on H2 ("must be in the GROUP BY list"). Group by the expression,
  and run one question on top of a new model before calling it done.
- **A column whose name looks like money (`cost`, `price`) becomes a currency column, USD by
  default**, and exports add "($)" to the header. Set `semantic_type` and `settings` for that
  column in `columns`.
- **Integer 0/1 flags show as numbers.** Return a real boolean from SQL when the column is a yes/no.

## Pivot tables

- **Pivot tables only work on MBQL (query builder) questions**, not native SQL. Put the SQL in a
  model, then build an MBQL question with `"source-card": "@card:models/x.json"`.
- **Conditional formatting on a pivot table is `table.column_formatting`.** The mb CLI docs
  name `pivot_table.column_formatting`, which Metabase ignores (checked against the Metabase
  1.63 frontend source).
- **Default collapse is `pivot_table.collapsed_rows: {"value": ["2"], "rows": [...]}`**, where
  `"N"` collapses level N (1-based). Collapsing in the UI and saving did not store it.
- **Every row group of a pivot needs the same depth.** When one section has no middle level,
  repeat the section as its own group rather than leaving the level empty.
- **Subtotals add up whatever is in the column**, mixed units included. Say so in the card
  description, or split the units.

## Dashboards

- **Filters only apply through `parameter_mappings`.** A card opened on its own (not from the
  dashboard) runs without the dashboard's filters; mention that in its description.
- **Each push replaces the whole dashcard list and its tabs rules** (`mb dashboard update --help`).
  Keep every dashcard in the definition.
- **Click behavior that jumps to another dashboard needs that dashboard's id**:
  use `"targetId": "@dashboard:dashboards/x.json"`; `mbac` creates both dashboards before
  filling them.
- **Built-in drill-through menus appear only on MBQL questions.** A native SQL card has none.

## Visualization settings in general

- **Unknown keys are dropped without an error.** When you set something you have not used before,
  push it to a non-protected profile and look at it (or ask the user to look), or check the key
  in `mb skills get visualization`. If you cannot confirm a setting, leave it out and tell the
  user to set it in the UI, then bring it back with `mbac diff`.

## Metabot

- **Metabot writing native SQL may fail to reference models** (`{{#142-...}}` came out mangled
  with a small model). Give models clear descriptions and column metadata; do not promise
  Metabot answers without trying the questions.
