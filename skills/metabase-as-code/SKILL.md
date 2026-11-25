---
name: metabase-as-code
description: Keep Metabase cards, questions, models, metrics and dashboards as files in a repo and push them with the bundled mbac script (built on the official mb CLI), instead of creating or editing them directly in Metabase. Use this skill BEFORE creating or changing any Metabase card, model or dashboard from the terminal, and prefer it over calling "mb card create/update" or "mb dashboard create/update" yourself. Trigger it whenever the user wants to build, change, deploy, sync or fix Metabase content, e.g. "make a Metabase dashboard for X", "add a model on top of this table", "push this to Metabase", "update the pivot card", "someone changed the dashboard in the UI", "set up drill-down between dashboards", "deploy the Metabase content to production", or when a repo has a metabase/ folder with mbac.json. Not for reading data, ad-hoc queries, or Metabase admin settings: use metabase-cli for those.
---

# metabase-as-code

The repo is the source of truth; Metabase shows what was deployed. Every card, model and
dashboard is a file in the repo. `mbac` turns those files into `mb` calls, remembers the
Metabase id of each file per profile, and refuses to overwrite edits someone made in the UI.

Why this matters: content created with `mb card create` exists only inside Metabase. Nobody can
review it, there is no history, it cannot be rebuilt on another instance, and the next agent does
not know which ids belong to which piece of work. Pushing from files fixes all four.

The script is `scripts/mbac.mjs` in this skill's directory (Node 20+, the same runtime `mb` needs).
Below, `mbac` means `node <this skill's directory>/scripts/mbac.mjs`. Run `mbac --help` for every option.

## 1. Find or create the content root

The content root is the directory holding `mbac.json`, usually `<repo>/metabase/`. `mbac` finds it
by walking up from the current directory.

- **It exists**: read `mbac.json` (profiles, which ones are protected) and run `mbac status`.
  Status shows which definitions are pushed, and which ones changed in Metabase since the last push.
- **It does not exist**: ask which `mb` profile and which Metabase database to use if it is not
  obvious (`mb auth list`, `mb db list --profile P`), then:

  ```bash
  mbac init --profile <profile> --database "<database name in Metabase>"   # add --protected for production
  ```

  Add a second profile (for example a local Metabase next to production) by editing `mbac.json`.

## 2. Write the definitions

```text
metabase/
├── mbac.json             # profiles: database, protected
├── collections.json      # key -> {name, description, parent}
├── models/<name>.sql     # native SQL ...
├── models/<name>.json    # ... plus its card definition (name, type, collection, columns)
├── cards/<name>.json     # MBQL questions carry their own dataset_query
├── dashboards/<name>.json
└── ids/<profile>.json    # written by mbac: Metabase ids per profile. Commit it.
```

Never write numeric Metabase ids into definitions. Use placeholders; `mbac` resolves them per profile:

| Placeholder | Becomes |
| --- | --- |
| `"@database"` | id of the profile's database |
| `"@card:models/orders.json"` | id of that card on this profile |
| `"@dashboard:dashboards/detail.json"` | id of that dashboard (click behavior targets, links) |
| `"@collection:main"` | id of that collection |
| `"@table:PUBLIC.ORDERS"`, `"@field:ORDERS.TOTAL"` | table / field id, looked up by name |
| `@@card:models/orders.json@@` inside a longer string or a .sql file | the id, spliced into the text |

Read [references/format.md](references/format.md) for the fields of each file, with examples.
For the bodies themselves (MBQL, visualization settings, dashboard filters, click behavior),
the `mb` CLI ships the authoritative docs: `mb skills get mbql`, `mb skills get visualization`,
`mb skills get dashboard`, `mb skills get native-sql`.

Fill in `description` on every card and `columns` (display name, description) on every model:
they are what people and Metabot read to understand the data.

## 3. Check, push, verify

1. `mbac render <file>` prints the exact body with placeholders resolved, without writing.
   Try the query before pushing: native SQL with `mb query --profile P`, MBQL by saving the
   rendered `dataset_query` to a file and running `mb query --file`.
2. `mbac push <file>...` pushes what you changed. `mbac push --all` pushes everything in
   dependency order (collections, then cards that others reference, then dashboards).
3. Verify in Metabase rather than assuming: run the card (`mb card query <id> --profile P`),
   check that the numbers match an independent source when one exists, and give the user the
   URLs `mbac` printed so they can look at the result.
4. Commit the definitions together with `ids/<profile>.json`.

## 4. Protected profiles (production)

A profile marked `"protected": true` will not get new cards, dashboards or collections unless you
pass `--create`. That flag is the user's decision, not yours: before pushing anything to a
protected profile, say what will be created or changed and wait for the user's go-ahead in this
conversation. Push to a non-protected profile first when the project has one.

## 5. When push refuses

- **"changed in Metabase since the last push"**: someone edited the item in the UI. Run
  `mbac diff <file>` (`-` lines are the repo, `+` lines are Metabase). Copy the changes worth
  keeping into the definition, then `mbac push --force <file>`. If you cannot tell whether an
  edit was intentional, show the diff to the user and ask. Do not reach for `--force` first: it
  throws away whatever the UI edit did.
- **"no record of a previous push"**: the id was recorded by hand (adopting existing content).
  Same procedure: diff, merge, then `--force`.
- **"has no id ... push it first"**: push the referenced file, or use `push --all`.
- **"no longer exists"**: it was deleted in Metabase. Remove its entry from `ids/<profile>.json`
  and push again to recreate it.

## 6. Things that fail silently

Metabase accepts many bodies and then ignores part of them. Before relying on a visualization
setting, a pivot table option or a filter wiring you have not used before, read
[references/pitfalls.md](references/pitfalls.md). It lists the traps met in real projects,
with what to do instead.

## Do not

- Create or update cards and dashboards with `mb card create/update`, `mb dashboard create/update`
  or the REST API. Everything goes through files and `mbac push`. Read-only `mb` commands
  (`get`, `list`, `query`, `search`) are fine.
- Edit content in the Metabase UI as a shortcut. If the user did, bring the change back with `mbac diff`.
- Write a new push script for the project. If `mbac` lacks something, say what is missing.
