# Eval results

## Iteration 1 (2026-11-25)

One run per configuration, Claude Opus 5.5, Metabase 0.61.3 (open source, Sample Database).

| Eval | With skill | Without skill | Difference |
| --- | --- | --- | --- |
| 0 new dashboard with click-to-filter | 5/5 | 2/5 | Without the skill: direct `mb card create`, field ids hard-coded, ids kept only in README prose |
| 1 colleague edited the card in the UI, then change it to bars | 5/5 | 4/5 | Both kept the UI edits; without the skill the change went out by direct `mb card update` |
| 2 new model on a protected (production) profile | 4/4 | 4/4 | Both wrote the files and stopped to ask |
| **Total** | **14/14 (100%)** | **10/14 (73%)** | |

Mean time 59 s with the skill, 71 s without. The skill loaded on its own in all three with-skill runs
(it was placed in the project's `.claude/skills/`; the prompt did not mention it).

### How the runs were made

- Each run was a separate `claude -p` process in its own fixture project. A first attempt with subagents was
  discarded: subagents inherited the parent conversation, so the baseline already knew about `mbac`.
- `mb` ran with `XDG_CONFIG_HOME` pointing at a config that holds only the `metabase-ai` profile, so no run could
  reach another Metabase.
- Assertions were checked by script against the files, the transcripts and Metabase itself.

### Limits

- Evals 1 and 2 start from a project that already uses the layout. Its `ids` file (with `updated_at`) and
  `"protected": true` in `mbac.json` guided the baseline, so these two barely discriminate. A sharper eval 2 would
  name the production profile only in the prompt or a README.
- Eval 0's baseline was rerun once: the first attempt found a same-named dashboard left by another run on the shared
  Metabase and stopped to ask.
- One run each; no variance estimate.
