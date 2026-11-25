# metabase-as-code Changelog

All notable changes to this skill will be documented in this file.

## [0.1.0] - 2026-11-25

### Added

- `scripts/mbac.mjs`: `init`, `status`, `render`, `diff`, `push` (single files or `--all` in dependency order)
- Ids kept per profile in `ids/<profile>.json`; placeholders for database, cards, dashboards, collections, tables and fields
- Guards: profiles must be listed in `mbac.json`; protected profiles need `--create`; `MB_URL`/`MB_API_KEY` removed;
  items edited in Metabase since the last push are not overwritten without `--force`
- Column metadata (`columns`) merged into `result_metadata`, running the card first when needed
- `references/format.md`, `references/pitfalls.md`
- Tests against a fake `mb` (`node --test test/`)
- Behavior evals: 14/14 with the skill, 10/14 without (`evals/RESULTS.md`)
