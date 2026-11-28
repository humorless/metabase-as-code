# File formats

Contents

- [mbac.json](#mbacjson)
- [collections.json](#collectionsjson)
- [Cards and models](#cards-and-models)
- [Dashboards](#dashboards)
- [ids/\<profile\>.json](#idsprofilejson)
- [Placeholders](#placeholders)
- [Adopting content that already exists in Metabase](#adopting-content-that-already-exists-in-metabase)

## mbac.json

```json
{
  "default_profile": "local",
  "profiles": {
    "local": { "database": "Warehouse (local)" },
    "prod": { "database": "Warehouse", "protected": true }
  }
}
```

- Profile names are `mb` profiles (`mb auth login --profile <name>`). Only listed profiles are accepted.
- `database`: the database name as Metabase shows it (`mb db list`), or its numeric id.
- `protected`: creating anything there needs `--create`. Ask the user first.
- Choose the profile with `--profile`, or `MBAC_PROFILE`, else `default_profile`.

## collections.json

```json
{
  "sales": { "name": "Sales analysis", "description": "Shown to the sales team" },
  "sales-drafts": { "name": "Drafts", "parent": "sales" }
}
```

The key is what definitions refer to. Missing collections are created on first use (on a
protected profile only with `--create`). `push --all` and `push collections.json` also update
names and descriptions.

## Cards and models

A card lives under `cards/`, `models/`, `metrics/` or `questions/` (the folder is only for
people; `type` decides what Metabase makes).

Native SQL: `models/orders_daily.sql` holds the query and `models/orders_daily.json` the rest.

```json
{
  "name": "Orders per day",
  "type": "model",
  "collection": "sales",
  "description": "One row per day and store. Revenue is gross, before refunds.",
  "display": "table",
  "visualization_settings": {},
  "columns": {
    "ORDER_DATE": { "display_name": "Order date", "description": "Day the order was placed" },
    "REVENUE": {
      "display_name": "Revenue",
      "description": "Sum of order totals, TWD",
      "semantic_type": null,
      "settings": { "number_style": "decimal" }
    }
  }
}
```

- `type`: `question` (default), `model` or `metric`.
- `display` defaults to `table`; `visualization_settings` defaults to `{}`.
- `columns` is merged into the card's `result_metadata` after each push: the column names and
  descriptions Metabot and the data browser show. Keys are column names exactly as the query
  returns them (H2 and Snowflake upper-case them). Any `result_metadata` key works
  (`semantic_type`, `settings`, ...). Columns the query does not return produce a warning.
- `template-tags`: for native SQL with `{{variables}}`, the stage's template tags (see
  `mb skills get native-sql`).
- `parameters`: passed through to the card.

MBQL question (no .sql file; required for pivot tables, and for drill-through menus):

```json
{
  "name": "Revenue by category",
  "collection": "sales",
  "display": "bar",
  "visualization_settings": { "graph.dimensions": ["CATEGORY"], "graph.metrics": ["sum"] },
  "dataset_query": {
    "lib/type": "mbql/query",
    "database": "@database",
    "stages": [
      {
        "lib/type": "mbql.stage/mbql",
        "source-card": "@card:models/orders_daily.json",
        "aggregation": [["sum", {}, ["field", {}, "REVENUE"]]],
        "breakout": [["field", {}, "CATEGORY"]]
      }
    ]
  }
}
```

## Dashboards

```json
{
  "name": "Sales overview",
  "collection": "sales",
  "description": "Start here.",
  "parameters": [
    { "id": "f_date", "name": "Period", "slug": "period", "type": "date/all-options", "default": "past1months" }
  ],
  "dashcards": [
    {
      "card_id": "@card:cards/revenue_by_category.json",
      "row": 0, "col": 0, "size_x": 12, "size_y": 6,
      "parameter_mappings": [
        { "parameter_id": "f_date", "card_id": "@card:cards/revenue_by_category.json",
          "target": ["dimension", ["field", "ORDER_DATE", { "base-type": "type/Date" }]] }
      ],
      "visualization_settings": {
        "click_behavior": { "type": "link", "linkType": "dashboard",
          "targetId": "@dashboard:dashboards/category_detail.json", "parameterMapping": {} }
      }
    },
    {
      "card_id": null, "row": 6, "col": 0, "size_x": 24, "size_y": 2,
      "visualization_settings": {
        "virtual_card": { "name": null, "display": "text", "visualization_settings": {}, "dataset_query": {}, "archived": false },
        "text": "[Details](/dashboard/@@dashboard:dashboards/category_detail.json@@)"
      }
    }
  ]
}
```

- Each push replaces the whole dashcard list. Dashcards without an `id` get negative ids
  (new dashcards) automatically.
- `tabs` is passed through when present (`mb dashboard update --help` explains the rules).
- Dashboards that link to each other work: `push` creates empty dashboards first, then pushes cards, then fills the
  dashboards. A card can therefore name a dashboard too, for example a native SQL column
  `@@dashboard:dashboards/detail.json@@` that a URL click behavior reads.

## ids/\<profile\>.json

Written by `mbac`; commit it so everyone deploys to the same ids.

```json
{
  "collections": { "sales": 8 },
  "items": {
    "models/orders_daily.json": { "id": 134, "updated_at": "2026-11-24T10:15:46.531+08:00" },
    "dashboards/overview.json": { "id": 11, "updated_at": "2026-11-24T10:16:02.120+08:00" }
  }
}
```

`updated_at` is Metabase's timestamp right after the last push. When Metabase reports a different
one, someone changed the item since, and `push` refuses until you `diff` and `--force`.

A local profile that is recreated often can have its ids file in `.gitignore`; a shared or
production profile's ids file belongs in the repo.

## Placeholders

| Placeholder | Resolves to | Lookup |
| --- | --- | --- |
| `"@database"` | database id | `database` of the profile in mbac.json |
| `"@card:<path>"` | card id | `items[<path>]` in ids/\<profile\>.json; path relative to the content root |
| `"@dashboard:<path>"` | dashboard id | same |
| `"@collection:<key>"` | collection id | `collections[<key>]` |
| `"@table:[schema.]table"` | table id | by name in the profile's database; add the schema when ambiguous |
| `"@field:[schema.]table.column"` | field id | by name |

A placeholder that is the whole JSON string becomes a number. Inside a longer string, or in a
.sql file, wrap it as `@@card:models/x.json@@`: the id is spliced into the text.
An unresolvable placeholder stops the push before anything is sent.

## Adopting content that already exists in Metabase

1. Write the definition (`mb card get <id> --full --json` shows the current body; copy the query
   into a .sql file or `dataset_query`, and replace ids with placeholders).
2. Record the id by hand in `ids/<profile>.json` as `"items": {"<path>": {"id": <id>}}`.
3. `mbac diff <path>` until it shows only what you mean to change, then `mbac push --force <path>`.
   From then on, normal pushes work.
