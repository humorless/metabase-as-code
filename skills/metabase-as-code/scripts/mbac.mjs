#!/usr/bin/env node
// mbac: Metabase as code. Pushes card, model and dashboard definitions kept in a
// repo to Metabase through the official mb CLI, and keeps the Metabase ids per profile.
// Run "mbac.mjs --help" for usage. Needs Node 20+ and mb (npm i -g @metabase/cli).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE = `mbac: keep Metabase cards, models and dashboards in a repo and push them with mb

Usage:
  mbac.mjs init [--root DIR] --profile NAME --database DB_NAME [--protected]
  mbac.mjs status [--profile NAME]
  mbac.mjs render <file> [--profile NAME]
  mbac.mjs diff <file> [--profile NAME]
  mbac.mjs push [--create] [--force] [--profile NAME] <file>...
  mbac.mjs push --all [--create] [--force] [--profile NAME]

Files are paths to definitions under the content root (the directory holding mbac.json,
found by walking up from the current directory, or given with --root).
  cards/ models/ metrics/ questions/   card definitions: <name>.json (+ <name>.sql for native SQL)
  dashboards/                          dashboard definitions: <name>.json
  collections.json                     collection key -> {name, description, parent}

Profile: --profile, else MBAC_PROFILE, else default_profile in mbac.json. Only profiles listed
in mbac.json are accepted. MB_URL and MB_API_KEY are always removed from mb's environment, so
the profile alone decides which Metabase is used.

push     Creates items without an id for this profile (a protected profile needs --create),
         updates the rest. Refuses to overwrite an item that changed in Metabase since the
         last push (someone edited it in the UI) unless --force; run diff first.
render   Prints the body push would send, with placeholders resolved. Writes nothing.
diff     Compares the rendered body with what is in Metabase now; exit 1 when they differ.
status   Lists every definition with its id and whether Metabase changed since the last push.

Exit codes: 0 ok, 1 failure or diff found differences, 2 usage error or refused by a guard.
`;

const CARD_DIRS = new Set(["cards", "models", "metrics", "questions"]);
const SERVER_DASHCARD_KEYS = new Set([
  "id",
  "created_at",
  "updated_at",
  "entity_id",
  "dashboard_id",
  "card",
  "collection_authority_level",
  "action_id",
  "series",
]);

class UserError extends Error {}

// ---------- small helpers ----------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`warning: ${msg}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`cannot read ${file}: ${e.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(["--profile", "--root", "--database"]);
  const flags = new Set(["--create", "--force", "--all", "--protected", "--help", "-h"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, ...val] = a.split("=");
    if (valued.has(a)) {
      if (i + 1 >= argv.length) throw new UserError(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (val.length && valued.has(key)) {
      opts[key.slice(2)] = val.join("=");
    } else if (flags.has(a)) {
      opts[a.replace(/^-+/, "")] = true;
    } else if (a.startsWith("-")) {
      throw new UserError(`unknown option ${a}`);
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// ---------- mb ----------

function runMb(profile, args, { allowFail = false, raw = false } = {}) {
  const env = { ...process.env };
  // mb prefers MB_URL / MB_API_KEY over --profile; a shell still holding production values
  // would send a "local" push to production. The profile alone decides.
  delete env.MB_URL;
  delete env.MB_API_KEY;
  const bin = process.env.MBAC_MB || "mb";
  const full = [...args, "--profile", profile, "--json"];
  // mb cuts output at 24 KB by default, which truncates cards with many columns.
  if (!raw) full.push("--max-bytes", "0");
  const r = spawnSync(bin, full, { env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new Error(`cannot run ${bin}: ${r.error.message}`);
  if (r.status !== 0) {
    const out = `${r.stdout}${r.stderr}`.trim();
    if (allowFail) return { failed: true, out };
    throw new Error(`mb ${args.slice(0, 3).join(" ")} failed (exit ${r.status}): ${out}`);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function withBodyFile(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbac-"));
  const file = path.join(dir, "body.json");
  try {
    fs.writeFileSync(file, JSON.stringify(body));
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isNotFound(out) {
  return /not found|404/i.test(out);
}

// ---------- project ----------

function findRoot(opts) {
  if (opts.root) {
    const r = path.resolve(opts.root);
    if (!fs.existsSync(path.join(r, "mbac.json"))) throw new UserError(`${r} has no mbac.json`);
    return r;
  }
  let dir = process.cwd();
  for (;;) {
    for (const cand of [dir, path.join(dir, "metabase")]) {
      if (fs.existsSync(path.join(cand, "mbac.json"))) return cand;
    }
    const up = path.dirname(dir);
    if (up === dir) throw new UserError("no mbac.json found (run init first, or pass --root)");
    dir = up;
  }
}

class Project {
  constructor(root, profileName) {
    this.root = root;
    this.config = readJson(path.join(root, "mbac.json"));
    const profiles = this.config.profiles || {};
    const name = profileName || process.env.MBAC_PROFILE || this.config.default_profile;
    if (!name) throw new UserError("no profile: pass --profile or set default_profile in mbac.json");
    if (!profiles[name]) {
      const listed = Object.keys(profiles).join(", ") || "none";
      throw new UserError(`profile ${name} is not listed in mbac.json (listed: ${listed})`);
    }
    this.profile = name;
    this.pconf = profiles[name];
    this.idsFile = path.join(root, "ids", `${name}.json`);
    this.ids = fs.existsSync(this.idsFile) ? readJson(this.idsFile) : {};
    this.ids.collections ??= {};
    this.ids.items ??= {};
    const colFile = path.join(root, "collections.json");
    this.collections = fs.existsSync(colFile) ? readJson(colFile) : {};
    this._db = undefined;
    this._tables = undefined;
  }

  saveIds() {
    writeJson(this.idsFile, this.ids);
  }

  mb(args, o) {
    return runMb(this.profile, args, o);
  }

  rel(file) {
    const abs = path.resolve(file);
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) throw new UserError(`${file} is outside the content root ${this.root}`);
    return rel;
  }

  kind(rel) {
    if (rel === "collections.json") return "collections";
    const top = rel.split("/")[0];
    if (top === "dashboards") return "dashboard";
    if (CARD_DIRS.has(top)) return "card";
    throw new UserError(`${rel}: definitions live under ${[...CARD_DIRS, "dashboards"].join("/, ")}/`);
  }

  allDefinitions() {
    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(rel);
        else if (ent.name.endsWith(".json")) out.push(rel);
      }
    };
    for (const top of [...CARD_DIRS, "dashboards"]) {
      if (fs.existsSync(path.join(this.root, top))) walk(top);
    }
    return out.sort();
  }

  // ----- lookups for placeholders -----

  databaseId() {
    if (this._db !== undefined) return this._db;
    const want = this.pconf.database;
    if (want === undefined) throw new UserError(`profile ${this.profile} has no "database" in mbac.json`);
    if (typeof want === "number") {
      this._db = want;
      return want;
    }
    const res = this.mb(["db", "list"]);
    const list = res.data || res;
    const hits = list.filter((d) => d.name === want);
    if (hits.length !== 1) {
      const names = list.map((d) => d.name).join(", ");
      throw new UserError(
        `database "${want}" matched ${hits.length} databases on profile ${this.profile} (have: ${names})`,
      );
    }
    this._db = hits[0].id;
    return this._db;
  }

  tables() {
    if (!this._tables) {
      const db = this.mb(["db", "get", String(this.databaseId()), "--include", "tables.fields"]);
      this._tables = db.tables || [];
    }
    return this._tables;
  }

  findTable(spec) {
    const parts = spec.split(".");
    const name = parts.pop();
    const schema = parts.length ? parts.join(".") : null;
    const hits = this.tables().filter((t) => t.name === name && (schema === null || t.schema === schema));
    if (hits.length !== 1) {
      const hint = hits.length > 1 ? " (add the schema)" : "";
      throw new UserError(`@table:${spec} matched ${hits.length} tables${hint}`);
    }
    return hits[0];
  }

  lookup(ref) {
    const colon = ref.indexOf(":");
    const kind = colon < 0 ? ref : ref.slice(0, colon);
    const rest = colon < 0 ? "" : ref.slice(colon + 1);
    switch (kind) {
      case "database":
        return this.databaseId();
      case "collection":
        return this.collectionId(rest, { mustExist: true });
      case "card":
      case "dashboard": {
        const item = this.ids.items[rest];
        if (!item?.id) {
          throw new UserError(
            `@${ref}: ${rest} has no id on profile ${this.profile}; push it first (or use push --all)`,
          );
        }
        return item.id;
      }
      case "table":
        return this.findTable(rest).id;
      case "field": {
        const dot = rest.lastIndexOf(".");
        if (dot < 0) throw new UserError(`@field:${rest} must be <table>.<column> or <schema>.<table>.<column>`);
        const table = this.findTable(rest.slice(0, dot));
        const col = rest.slice(dot + 1);
        const f = (table.fields || []).find((x) => x.name === col);
        if (!f) throw new UserError(`@field:${rest}: table ${table.name} has no column ${col}`);
        return f.id;
      }
      default:
        throw new UserError(`unknown placeholder @${ref}`);
    }
  }

  resolve(value) {
    const WHOLE = /^@(database|(?:card|dashboard|collection|table|field):.+)$/;
    const EMBED = /@@(database|(?:card|dashboard|collection|table|field):[^@]+)@@/g;
    const walk = (v) => {
      if (typeof v === "string") {
        const m = v.match(WHOLE);
        if (m) return this.lookup(m[1]);
        return v.replace(EMBED, (_, ref) => String(this.lookup(ref)));
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value);
  }

  // ----- collections -----

  collectionId(key, { mustExist = false, create = false } = {}) {
    if (this.ids.collections[key] !== undefined) return this.ids.collections[key];
    if (mustExist) throw new UserError(`collection ${key} has no id on profile ${this.profile}`);
    const def = this.collections[key];
    if (!def) throw new UserError(`collection "${key}" is not in collections.json`);
    if (this.pconf.protected && !create) {
      throw new UserError(
        `collection ${key} has no id on protected profile ${this.profile}. Record an existing collection ` +
          `as collections.${key} in ids/${this.profile}.json, or push with --create`,
      );
    }
    const body = { name: def.name, description: def.description ?? null };
    if (def.parent) body.parent_id = this.collectionId(def.parent, { create });
    const created = withBodyFile(body, (f) => this.mb(["collection", "create", "--file", f]));
    this.ids.collections[key] = created.id;
    this.saveIds();
    log(`created collection ${created.id} (${key})`);
    return created.id;
  }

  syncCollection(key, opts) {
    const existed = this.ids.collections[key] !== undefined;
    const id = this.collectionId(key, opts);
    const def = this.collections[key];
    if (!existed || !def) return;
    const cur = this.mb(["collection", "get", String(id)]);
    const want = { name: def.name, description: def.description ?? null };
    if (cur.name !== want.name || (cur.description ?? null) !== want.description) {
      withBodyFile(want, (f) => this.mb(["collection", "update", String(id), "--file", f]));
      log(`updated collection ${id} (${key})`);
    }
  }

  // ----- rendering -----

  cardBody(rel) {
    const def = readJson(path.join(this.root, rel));
    const sqlFile = path.join(this.root, rel.replace(/\.json$/, ".sql"));
    const hasSql = fs.existsSync(sqlFile);
    if (hasSql && def.dataset_query) throw new UserError(`${rel} has both a .sql file and dataset_query; keep one`);
    if (!hasSql && !def.dataset_query) throw new UserError(`${rel} needs a sibling .sql file or a dataset_query`);
    if (!def.name) throw new UserError(`${rel} has no name`);
    if (!def.collection) throw new UserError(`${rel} has no collection (a key of collections.json)`);
    let datasetQuery = def.dataset_query;
    if (hasSql) {
      const stage = { "lib/type": "mbql.stage/native", native: fs.readFileSync(sqlFile, "utf8") };
      if (def["template-tags"]) stage["template-tags"] = def["template-tags"];
      datasetQuery = { "lib/type": "mbql/query", database: "@database", stages: [stage] };
    }
    const body = {
      name: def.name,
      type: def.type || "question",
      description: def.description ?? null,
      display: def.display || "table",
      visualization_settings: def.visualization_settings || {},
      dataset_query: datasetQuery,
    };
    if (def.parameters) body.parameters = def.parameters;
    return { def, body: this.resolve(body), collectionKey: def.collection };
  }

  dashboardBody(rel) {
    const def = readJson(path.join(this.root, rel));
    if (!def.name) throw new UserError(`${rel} has no name`);
    if (!def.collection) throw new UserError(`${rel} has no collection (a key of collections.json)`);
    let next = -1;
    // mb replaces the whole dashcard list; new dashcards need negative ids.
    const dashcards = (def.dashcards || []).map((dc) => (dc.id === undefined ? { id: next--, ...dc } : dc));
    const body = {
      name: def.name,
      description: def.description ?? null,
      parameters: def.parameters || [],
      dashcards,
    };
    if (def.tabs) body.tabs = def.tabs;
    return { def, body: this.resolve(body), collectionKey: def.collection };
  }

  render(rel, { create = false, dryRun = false } = {}) {
    const kind = this.kind(rel);
    if (kind === "collections") throw new UserError("collections.json is pushed, not rendered");
    const r = kind === "card" ? this.cardBody(rel) : this.dashboardBody(rel);
    r.body.collection_id = dryRun
      ? (this.ids.collections[r.collectionKey] ?? `<new collection ${r.collectionKey}>`)
      : this.collectionId(r.collectionKey, { create });
    return { kind, ...r };
  }

  // ----- remote state -----

  remote(kind, id) {
    const res = this.mb([kind, "get", String(id), "--full"], { allowFail: true });
    if (res?.failed) {
      if (isNotFound(res.out)) return null;
      throw new Error(`mb ${kind} get ${id} failed: ${res.out}`);
    }
    return res;
  }

  guard(rel, kind, item, force) {
    const remote = this.remote(kind, item.id);
    const again = `Run diff, bring wanted UI changes into the repo, then push with --force`;
    if (!remote) {
      throw new UserError(
        `${rel}: ${kind} ${item.id} no longer exists on profile ${this.profile}. ` +
          `Remove items["${rel}"] from ids/${this.profile}.json to create it again`,
      );
    }
    if (force) return;
    if (remote.archived) {
      throw new UserError(`${rel}: ${kind} ${item.id} is archived in Metabase; restore it there or pass --force`);
    }
    if (!item.updated_at) {
      throw new UserError(`${rel}: no record of a previous push for ${kind} ${item.id}. ${again}`);
    }
    if (remote.updated_at !== item.updated_at) {
      throw new UserError(
        `${rel}: ${kind} ${item.id} changed in Metabase since the last push ` +
          `(${item.updated_at} -> ${remote.updated_at}). ${again}`,
      );
    }
  }

  record(rel, kind, id) {
    const r = this.mb([kind, "get", String(id), "--fields", "id,updated_at"]);
    this.ids.items[rel] = { id, updated_at: r.updated_at };
    this.saveIds();
  }

  createRefusal(rel) {
    return new UserError(
      `${rel} has no id on protected profile ${this.profile}. Creating it there needs --create ` +
        `(ask the owner of that Metabase first)`,
    );
  }

  // ----- push -----

  pushCard(rel, opts) {
    const { def, body } = this.render(rel, opts);
    const item = this.ids.items[rel];
    let id;
    if (!item) {
      if (this.pconf.protected && !opts.create) throw this.createRefusal(rel);
      id = withBodyFile(body, (f) => this.mb(["card", "create", "--file", f])).id;
      // Record right away, so a failure later in this push does not orphan the new card.
      this.record(rel, "card", id);
      log(`created card ${id}: ${rel}`);
    } else {
      this.guard(rel, "card", item, opts.force);
      id = item.id;
      withBodyFile(body, (f) => this.mb(["card", "update", String(id), "--file", f]));
      this.record(rel, "card", id);
      log(`updated card ${id}: ${rel}`);
    }
    if (def.columns) this.mergeColumns(rel, id, def.columns);
    this.record(rel, "card", id);
    return id;
  }

  mergeColumns(rel, id, columns) {
    let card = this.mb(["card", "get", String(id), "--full"]);
    if (!Array.isArray(card.result_metadata)) {
      // A native card made through the API has no result_metadata until it runs once.
      this.mb(["card", "query", String(id), "--limit", "1"]);
      card = this.mb(["card", "get", String(id), "--full"]);
    }
    if (!Array.isArray(card.result_metadata)) {
      warn(`${rel}: card ${id} still has no result_metadata after running it; column metadata not applied`);
      return;
    }
    const names = new Set(card.result_metadata.map((c) => c.name));
    const missing = Object.keys(columns).filter((k) => !names.has(k));
    if (missing.length) warn(`${rel}: the query returns no column named ${missing.join(", ")}`);
    const merged = card.result_metadata.map((c) => ({ ...c, ...(columns[c.name] || {}) }));
    withBodyFile({ result_metadata: merged }, (f) => this.mb(["card", "update", String(id), "--file", f]));
    log(`updated column metadata of card ${id}`);
  }

  ensureDashboardShell(rel, opts) {
    if (this.ids.items[rel]) return false;
    if (this.pconf.protected && !opts.create) throw this.createRefusal(rel);
    const def = readJson(path.join(this.root, rel));
    const shell = { name: def.name, collection_id: this.collectionId(def.collection, opts) };
    const id = withBodyFile(shell, (f) => this.mb(["dashboard", "create", "--file", f])).id;
    this.record(rel, "dashboard", id);
    log(`created dashboard ${id}: ${rel}`);
    return true;
  }

  pushDashboard(rel, opts, fresh) {
    const item = this.ids.items[rel];
    if (!fresh) this.guard(rel, "dashboard", item, opts.force);
    const { body } = this.render(rel, opts);
    withBodyFile(body, (f) => this.mb(["dashboard", "update", String(item.id), "--file", f]));
    log(`updated dashboard ${item.id}: ${rel}`);
    this.record(rel, "dashboard", item.id);
    return item.id;
  }

  cardDeps(rel) {
    const sqlFile = path.join(this.root, rel.replace(/\.json$/, ".sql"));
    let text = fs.readFileSync(path.join(this.root, rel), "utf8");
    if (fs.existsSync(sqlFile)) text += fs.readFileSync(sqlFile, "utf8");
    return [...text.matchAll(/@@?card:([^"@\s]+\.json)/g)].map((m) => m[1]);
  }

  orderCards(rels) {
    const set = new Set(rels);
    const done = new Set();
    const visiting = new Set();
    const out = [];
    const visit = (r, trail) => {
      if (done.has(r)) return;
      if (visiting.has(r)) throw new UserError(`card references form a cycle: ${[...trail, r].join(" -> ")}`);
      visiting.add(r);
      for (const d of this.cardDeps(r)) if (set.has(d)) visit(d, [...trail, r]);
      visiting.delete(r);
      done.add(r);
      out.push(r);
    };
    for (const r of rels) visit(r, []);
    return out;
  }

  baseUrl() {
    const s = runMb(this.profile, ["auth", "status"], { allowFail: true, raw: true });
    return s && !s.failed ? String(s.url || "").replace(/\/$/, "") : "";
  }
}

// ---------- diff ----------

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

// Metabase adds a "lib/uuid" to every MBQL clause it stores; they are not part of the definition.
function withoutUuids(v) {
  if (Array.isArray(v)) return v.map(withoutUuids);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "lib/uuid").map(([k, x]) => [k, withoutUuids(x)]));
  }
  return v;
}

function nativeSql(q) {
  if (q?.stages?.[0]?.native !== undefined) return q.stages[0].native;
  if (q?.native?.query !== undefined) return q.native.query;
  return null;
}

function diffView(kind, local, remote, def) {
  const l = {};
  const r = {};
  for (const k of ["name", "description", "display", "type", "visualization_settings", "parameters"]) {
    if (local[k] !== undefined) {
      l[k] = local[k];
      r[k] = remote[k] ?? null;
    }
  }
  if (kind === "card") {
    const sql = nativeSql(local.dataset_query);
    if (sql !== null) {
      l.sql = sql;
      r.sql = nativeSql(remote.dataset_query);
    } else {
      l.dataset_query = withoutUuids(local.dataset_query);
      r.dataset_query = withoutUuids(remote.dataset_query);
    }
    if (def.columns) {
      const meta = Object.fromEntries((remote.result_metadata || []).map((c) => [c.name, c]));
      // Columns the query does not return cannot carry metadata; push already warned about them.
      const known = Object.entries(def.columns).filter(([name]) => meta[name]);
      l.columns = Object.fromEntries(known);
      r.columns = Object.fromEntries(
        known.map(([name, want]) => [
          name,
          Object.fromEntries(Object.keys(want).map((k) => [k, meta[name]?.[k] ?? null])),
        ]),
      );
    }
  } else {
    const strip = (dc) => Object.fromEntries(Object.entries(dc).filter(([k]) => !SERVER_DASHCARD_KEYS.has(k)));
    l.dashcards = local.dashcards.map(strip);
    r.dashcards = (remote.dashcards || []).map((dc, i) => {
      const keys = Object.keys(strip(local.dashcards[i] || dc));
      return Object.fromEntries(keys.map((k) => [k, dc[k] ?? null]));
    });
  }
  return { l: sortKeys(l), r: sortKeys(r) };
}

// ---------- commands ----------

function cmdInit(opts) {
  const root = path.resolve(opts.root || "metabase");
  if (!opts.profile || !opts.database) throw new UserError("init needs --profile NAME and --database DB_NAME");
  const cfgFile = path.join(root, "mbac.json");
  if (fs.existsSync(cfgFile)) throw new UserError(`${cfgFile} already exists`);
  const profile = { database: /^\d+$/.test(opts.database) ? Number(opts.database) : opts.database };
  if (opts.protected) profile.protected = true;
  writeJson(cfgFile, { default_profile: opts.profile, profiles: { [opts.profile]: profile } });
  const colFile = path.join(root, "collections.json");
  if (!fs.existsSync(colFile)) writeJson(colFile, {});
  for (const d of ["models", "cards", "dashboards", "ids"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    const keep = path.join(root, d, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  }
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, ".scratch/\n");
  log(`initialised ${root} (profile ${opts.profile}, database ${opts.database})`);
}

function cmdStatus(project) {
  const rows = [];
  for (const rel of project.allDefinitions()) {
    const kind = project.kind(rel);
    const item = project.ids.items[rel];
    let state = "not pushed";
    if (item) {
      const remote = project.mb([kind, "get", String(item.id), "--fields", "id,updated_at,archived"], {
        allowFail: true,
      });
      if (remote?.failed) state = isNotFound(remote.out) ? "missing in Metabase" : `error: ${remote.out}`;
      else if (remote.archived) state = "archived in Metabase";
      else if (!item.updated_at) state = "no push record (run diff)";
      else if (remote.updated_at !== item.updated_at) state = "changed in Metabase since last push";
      else state = "in sync";
    }
    rows.push(`${String(item?.id ?? "-").padStart(5)}  ${kind.padEnd(9)}  ${rel}  [${state}]`);
  }
  log(`profile ${project.profile}${project.pconf.protected ? " (protected)" : ""}`);
  log(rows.join("\n") || "(no definitions)");
}

function cmdRender(project, files) {
  if (files.length !== 1) throw new UserError("render takes one file");
  const { body } = project.render(project.rel(files[0]), { dryRun: true });
  log(JSON.stringify(body, null, 2));
}

function cmdDiff(project, files) {
  if (files.length !== 1) throw new UserError("diff takes one file");
  const rel = project.rel(files[0]);
  const kind = project.kind(rel);
  const item = project.ids.items[rel];
  if (!item) throw new UserError(`${rel} has not been pushed to profile ${project.profile}`);
  const { body, def } = project.render(rel, { dryRun: true });
  const remote = project.remote(kind, item.id);
  if (!remote) throw new UserError(`${kind} ${item.id} no longer exists on profile ${project.profile}`);
  const { l, r } = diffView(kind, body, remote, def);
  const dir = path.join(project.root, ".scratch", "diff", project.profile);
  const base = path.join(dir, rel.replace(/\//g, "__"));
  fs.mkdirSync(dir, { recursive: true });
  const lf = `${base}.repo.json`;
  const rf = `${base}.metabase.json`;
  fs.writeFileSync(lf, `${JSON.stringify(l, null, 2)}\n`);
  fs.writeFileSync(rf, `${JSON.stringify(r, null, 2)}\n`);
  const out = spawnSync("diff", ["-u", lf, rf], { encoding: "utf8" }).stdout;
  if (!out) {
    log(`${rel}: repo and Metabase (${kind} ${item.id}) agree`);
    return 0;
  }
  log(out);
  log(`full copies: ${lf} and ${rf}`);
  return 1;
}

function cmdPush(project, opts) {
  let files;
  if (opts.all) {
    if (opts._.length) throw new UserError("push --all takes no files");
    files = ["collections.json", ...project.allDefinitions()];
  } else {
    if (!opts._.length) throw new UserError("push needs files, or --all");
    files = opts._.map((f) => project.rel(f));
  }
  if (files.includes("collections.json")) {
    for (const key of Object.keys(project.collections)) project.syncCollection(key, opts);
  }
  const cards = project.orderCards(files.filter((r) => project.kind(r) === "card"));
  const dashboards = files.filter((r) => project.kind(r) === "dashboard");
  const base = project.baseUrl();
  const urls = [];
  // Dashboard shells before cards: dashboards that link to each other, and cards whose SQL or
  // settings name a dashboard (@@dashboard:...@@ in a link column), can then resolve its id.
  const fresh = new Set(dashboards.filter((rel) => project.ensureDashboardShell(rel, opts)));
  for (const rel of cards) urls.push(`${base}/question/${project.pushCard(rel, opts)}  ${rel}`);
  for (const rel of dashboards) {
    urls.push(`${base}/dashboard/${project.pushDashboard(rel, opts, fresh.has(rel))}  ${rel}`);
  }
  if (urls.length) log(`\n${urls.join("\n")}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || ["--help", "-h", "help"].includes(cmd)) {
    log(USAGE);
    return 0;
  }
  const opts = parseArgs(rest);
  if (opts.help || opts.h) {
    log(USAGE);
    return 0;
  }
  if (cmd === "init") {
    cmdInit(opts);
    return 0;
  }
  const project = new Project(findRoot(opts), opts.profile);
  switch (cmd) {
    case "status":
      cmdStatus(project);
      return 0;
    case "render":
      cmdRender(project, opts._);
      return 0;
    case "diff":
      return cmdDiff(project, opts._);
    case "push":
      cmdPush(project, opts);
      return 0;
    default:
      throw new UserError(`unknown command ${cmd}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`mbac: ${e.message}\n`);
  process.exitCode = e instanceof UserError ? 2 : 1;
}
