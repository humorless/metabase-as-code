#!/usr/bin/env node
// A stand-in for the mb CLI, enough for mbac's tests. State lives in FAKE_MB_STATE.
// Every call is appended to state.calls. It fails when MB_URL or MB_API_KEY is set,
// because mbac must remove them.
import fs from "node:fs";

const stateFile = process.env.FAKE_MB_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.filter((a) => !a.startsWith("/")).join(" "));
let clock = state.clock || 0;
const now = () => `t${++clock}`;
const out = (v) => process.stdout.write(JSON.stringify(v));
const fail = (msg) => {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: msg } }));
  save();
  process.exit(1);
};
function save() {
  state.clock = clock;
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
function opt(name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
const body = () => JSON.parse(fs.readFileSync(opt("--file"), "utf8"));

if (process.env.MB_URL || process.env.MB_API_KEY) fail("MB_URL or MB_API_KEY leaked into mb's environment");
const [group, verb, id] = args;
const store = { card: state.cards, dashboard: state.dashboards, collection: state.collections };
const nextId = () => ++state.lastId;

if (group === "auth") out({ url: "http://mb.test" });
else if (group === "db" && verb === "list") out({ data: state.databases.map(({ id, name }) => ({ id, name })) });
else if (group === "db" && verb === "get") out(state.databases.find((d) => d.id === Number(id)));
else if (verb === "create") {
  const nid = nextId();
  store[group][nid] = { ...body(), id: nid, updated_at: now(), archived: false, result_metadata: null };
  out(store[group][nid]);
} else if (verb === "update") {
  const cur = store[group][id];
  if (!cur) fail("Not found.");
  Object.assign(cur, body(), { updated_at: now() });
  out(cur);
} else if (verb === "get") {
  const cur = store[group][id];
  if (!cur) fail("Not found.");
  const fields = opt("--fields");
  out(fields ? Object.fromEntries(fields.split(",").map((k) => [k, cur[k]])) : cur);
} else if (group === "card" && verb === "query") {
  const cur = store.card[id];
  cur.result_metadata = (state.queryColumns[id] || ["A", "B"]).map((name) => ({ name, display_name: name }));
  out({ data: { rows: [] } });
} else fail(`fake mb does not know: ${args.join(" ")}`);
save();
