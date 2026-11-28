// Tests for scripts/mbac.mjs against test/fake-mb.mjs. Run: node --test test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MBAC = path.join(here, "..", "scripts", "mbac.mjs");
const FAKE = path.join(here, "fake-mb.mjs");

function setup({ protectedProfile = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbac-test-"));
  const root = path.join(dir, "metabase");
  const w = (rel, v) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2));
  };
  w("mbac.json", {
    default_profile: "dev",
    profiles: { dev: { database: "Warehouse", protected: protectedProfile } },
  });
  w("collections.json", { main: { name: "Main" } });
  w("models/orders.sql", "SELECT 1 AS A, 2 AS B");
  w("models/orders.json", {
    name: "Orders",
    type: "model",
    collection: "main",
    columns: { A: { display_name: "Alpha", description: "first" }, Z: { display_name: "missing" } },
  });
  w("cards/by_day.json", {
    name: "By day",
    collection: "main",
    dataset_query: {
      "lib/type": "mbql/query",
      database: "@database",
      stages: [{ "lib/type": "mbql.stage/mbql", "source-card": "@card:models/orders.json" }],
    },
  });
  w("cards/raw.json", {
    name: "Raw",
    collection: "main",
    dataset_query: {
      "lib/type": "mbql/query",
      database: "@database",
      stages: [{ "lib/type": "mbql.stage/mbql", "source-table": "@table:public.orders", fields: ["@field:orders.total"] }],
    },
  });
  w("dashboards/home.json", {
    name: "Home",
    collection: "main",
    dashcards: [
      { card_id: "@card:cards/by_day.json", row: 0, col: 0, size_x: 12, size_y: 6 },
      { card_id: null, row: 6, col: 0, size_x: 24, size_y: 2, visualization_settings: { text: "[more](/dashboard/@@dashboard:dashboards/more.json@@)" } },
    ],
  });
  w("dashboards/more.json", { name: "More", collection: "main", dashcards: [] });
  const stateFile = path.join(dir, "fake-state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      calls: [],
      lastId: 100,
      cards: {},
      dashboards: {},
      collections: {},
      queryColumns: {},
      databases: [
        {
          id: 7,
          name: "Warehouse",
          tables: [{ id: 30, name: "orders", schema: "public", fields: [{ id: 301, name: "total" }] }],
        },
      ],
    }),
  );
  const run = (args, env = {}) =>
    spawnSync("node", [MBAC, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MBAC_MB: FAKE, FAKE_MB_STATE: stateFile, MBAC_PROFILE: "", ...env },
    });
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const ids = () => JSON.parse(fs.readFileSync(path.join(root, "ids", "dev.json"), "utf8"));
  const mutate = (fn) => {
    const s = state();
    fn(s);
    fs.writeFileSync(stateFile, JSON.stringify(s));
  };
  return { dir, root, run, state, ids, mutate, w };
}

test("push --all creates everything in dependency order and resolves placeholders", () => {
  const t = setup();
  const r = t.run(["push", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  const ids = t.ids();
  const s = t.state();
  const model = ids.items["models/orders.json"].id;
  const byDay = s.cards[ids.items["cards/by_day.json"].id];
  assert.equal(byDay.dataset_query.database, 7);
  assert.equal(byDay.dataset_query.stages[0]["source-card"], model);
  const raw = s.cards[ids.items["cards/raw.json"].id];
  assert.equal(raw.dataset_query.stages[0]["source-table"], 30);
  assert.deepEqual(raw.dataset_query.stages[0].fields, [301]);
  const home = s.dashboards[ids.items["dashboards/home.json"].id];
  assert.equal(home.dashcards[0].card_id, ids.items["cards/by_day.json"].id);
  assert.equal(home.dashcards[0].id, -1);
  assert.equal(home.dashcards[1].visualization_settings.text, `[more](/dashboard/${ids.items["dashboards/more.json"].id})`);
  assert.equal(home.collection_id, ids.collections.main);
});

test("MB_URL and MB_API_KEY never reach mb", () => {
  const t = setup();
  const r = t.run(["push", "--all"], { MB_URL: "https://prod.example", MB_API_KEY: "secret" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a protected profile refuses to create without --create", () => {
  const t = setup({ protectedProfile: true });
  let r = t.run(["push", "metabase/models/orders.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /protected profile dev/);
  assert.equal(Object.keys(t.state().cards).length, 0);
  r = t.run(["push", "--create", "metabase/models/orders.json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Object.keys(t.state().cards).length, 1);
});

test("a profile not listed in mbac.json is refused", () => {
  const t = setup();
  const r = t.run(["status", "--profile", "prod"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not listed in mbac.json/);
});

test("an item changed in Metabase since the last push is not overwritten without --force", () => {
  const t = setup();
  assert.equal(t.run(["push", "--all"]).status, 0);
  const id = t.ids().items["cards/by_day.json"].id;
  t.mutate((s) => {
    s.cards[id].name = "edited in the UI";
    s.cards[id].updated_at = "ui-edit";
  });
  let r = t.run(["push", "metabase/cards/by_day.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /changed in Metabase since the last push/);
  assert.equal(t.state().cards[id].name, "edited in the UI");
  r = t.run(["diff", "metabase/cards/by_day.json"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /edited in the UI/);
  r = t.run(["push", "--force", "metabase/cards/by_day.json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.state().cards[id].name, "By day");
  assert.equal(t.run(["diff", "metabase/cards/by_day.json"]).status, 0);
});

test("columns are merged into result_metadata, running the card first when it has none", () => {
  const t = setup();
  const r = t.run(["push", "metabase/models/orders.json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no column named Z/);
  const card = t.state().cards[t.ids().items["models/orders.json"].id];
  assert.deepEqual(card.result_metadata, [
    { name: "A", display_name: "Alpha", description: "first" },
    { name: "B", display_name: "B" },
  ]);
  assert.ok(t.state().calls.some((c) => c.startsWith("card query")));
});

test("pushing a card before what it references names the file to push first", () => {
  const t = setup();
  const r = t.run(["push", "metabase/cards/by_day.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /models\/orders.json has no id on profile dev; push it first/);
});

test("render writes nothing", () => {
  const t = setup();
  const r = t.run(["render", "metabase/cards/raw.json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dataset_query.stages[0]["source-table"], 30);
  assert.ok(!t.state().calls.some((c) => / (create|update) /.test(` ${c} `)));
});

test("card reference cycles are reported", () => {
  const t = setup();
  t.w("models/orders.json", {
    name: "Orders",
    collection: "main",
    dataset_query: { database: "@database", stages: [{ "source-card": "@card:cards/by_day.json" }] },
  });
  fs.rmSync(path.join(t.root, "models", "orders.sql"));
  const r = t.run(["push", "--all"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cycle/);
});

test("a card's SQL can name a dashboard pushed in the same run", () => {
  const t = setup();
  t.w("cards/links.sql", "SELECT '/dashboard/@@dashboard:dashboards/more.json@@' AS TARGET");
  t.w("cards/links.json", { name: "Links", collection: "main" });
  const r = t.run(["push", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  const ids = t.ids();
  const card = t.state().cards[ids.items["cards/links.json"].id];
  assert.equal(card.dataset_query.stages[0].native, `SELECT '/dashboard/${ids.items["dashboards/more.json"].id}' AS TARGET`);
});

test("diff ignores the lib/uuid keys Metabase adds to MBQL clauses", () => {
  const t = setup();
  assert.equal(t.run(["push", "--all"]).status, 0);
  const id = t.ids().items["cards/by_day.json"].id;
  t.mutate((s) => {
    s.cards[id].dataset_query.stages[0]["lib/uuid"] = "3ba08134-2bba-496b-87b5-b3142bd154ee";
  });
  const r = t.run(["diff", "metabase/cards/by_day.json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
