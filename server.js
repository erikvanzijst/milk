import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import pg from "pg";

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = join(import.meta.dirname, "public");
const SPACING = 1024; // weight gap between items after a renumber
const MAX_NAME = 80;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// Freepod signs every visitor in and passes their verified email in
// X-Freepod-Email, but any Freepod account can sign in. Only the addresses in
// MILK_ALLOWED_EMAILS (separated by commas or whitespace) get in; when it is
// empty or unset, nobody does. Locally there is no sign-in, so MILK_DEV_EMAIL
// stands in for the header.
const ALLOWED_EMAILS = new Set(
  (process.env.MILK_ALLOWED_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean),
);
const DEV_EMAIL = process.env.MILK_DEV_EMAIL;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name       text NOT NULL,
      weight     double precision NOT NULL,
      on_list    boolean NOT NULL DEFAULT false,
      done       boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS items_name_key ON items (lower(name));
    CREATE INDEX IF NOT EXISTS items_weight_idx ON items (weight, id);
  `);
}

// ---------- data access ----------

const COLUMNS = "id::int AS id, name, weight, on_list, done";

async function allItems(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM items ORDER BY weight, id`);
  return rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function cleanName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length <= MAX_NAME ? trimmed : null;
}

// Create an item, or (if the name already exists, case-insensitively) put the
// existing one back on the list. The catalog never holds duplicates.
async function createItem({ name, on_list = true, done = false, weight }) {
  name = cleanName(name);
  if (!name) throw httpError(400, `Name must be 1–${MAX_NAME} characters`);
  return tx(async (db) => {
    const existing = await db.query(`SELECT id FROM items WHERE lower(name) = lower($1)`, [name]);
    if (existing.rowCount) {
      await db.query(`UPDATE items SET on_list = $2, done = $2 AND $3 WHERE id = $1`,
        [existing.rows[0].id, !!on_list, !!done]);
    } else {
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        const { rows } = await db.query(`SELECT coalesce(max(weight), 0) + $1 AS w FROM items`, [SPACING]);
        weight = rows[0].w;
      }
      await db.query(`INSERT INTO items (name, weight, on_list, done) VALUES ($1, $2, $3, $3 AND $4)`,
        [name, weight, !!on_list, !!done]);
    }
    return allItems(db);
  });
}

// Update on_list / done / name for one or more items. Taking an item off the
// list also clears its done flag, so it comes back fresh next time.
async function updateItems(ids, { on_list, done, name }) {
  if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) {
    throw httpError(400, "ids must be a non-empty array of integers");
  }
  const sets = [];
  const params = [ids];
  if (typeof on_list === "boolean") {
    params.push(on_list);
    sets.push(`on_list = $${params.length}`);
    if (!on_list) sets.push("done = false");
  }
  if (typeof done === "boolean" && on_list !== false) {
    params.push(done);
    sets.push(`done = $${params.length}`);
  }
  if (name !== undefined) {
    const clean = cleanName(name);
    if (!clean || ids.length !== 1) throw httpError(400, "Invalid name");
    params.push(clean);
    sets.push(`name = $${params.length}`);
  }
  if (!sets.length) throw httpError(400, "Nothing to update");
  try {
    await pool.query(`UPDATE items SET ${sets.join(", ")} WHERE id = ANY($1::bigint[])`, params);
  } catch (err) {
    if (err.code === "23505") throw httpError(409, "An item with that name already exists");
    throw err;
  }
  return allItems();
}

async function deleteItem(id) {
  await pool.query(`DELETE FROM items WHERE id = $1`, [id]);
  return allItems();
}

// Move an item directly before or after an anchor item in the global order.
// The new weight is the midpoint between the anchor and its neighbor; when
// repeated bisection runs out of room, the whole order is renumbered.
async function moveItem(id, anchorId, position) {
  if (!Number.isInteger(anchorId) || anchorId === id) throw httpError(400, "Invalid anchor");
  if (position !== "before" && position !== "after") throw httpError(400, "Invalid position");
  return tx(async (db) => {
    const { rows } = await db.query(`SELECT id::int AS id, weight FROM items ORDER BY weight, id FOR UPDATE`);
    const others = rows.filter((r) => r.id !== id);
    if (others.length === rows.length) throw httpError(404, "Item not found");
    const i = others.findIndex((r) => r.id === anchorId);
    if (i < 0) throw httpError(404, "Anchor not found");

    const insertAt = position === "before" ? i : i + 1;
    const prev = others[insertAt - 1];
    const next = others[insertAt];
    const lo = prev ? prev.weight : next.weight - SPACING;
    const hi = next ? next.weight : prev.weight + SPACING;
    const mid = (lo + hi) / 2;

    if (hi - lo > 1e-6 && mid > lo && mid < hi) {
      await db.query(`UPDATE items SET weight = $2 WHERE id = $1`, [id, mid]);
    } else {
      const order = others.map((r) => r.id);
      order.splice(insertAt, 0, id);
      await db.query(
        `UPDATE items SET weight = v.ord * $2
           FROM unnest($1::bigint[]) WITH ORDINALITY AS v(id, ord)
          WHERE items.id = v.id`,
        [order, SPACING],
      );
    }
    return allItems(db);
  });
}

// ---------- http ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, "Body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const type = TYPES[extname(rel)];
  if (!type) return false;
  try {
    const body = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendDenied(res, email) {
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Milk · No access</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  :root { --bg: #f5f3ee; --ink: #1b1a17; --ink-2: #6b675e; --accent: #2e7d4f; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141412; --ink: #f1eee6; --ink-2: #a8a397; --accent: #5cc48a; color-scheme: dark; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
    font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
  main { padding: 24px 16px; max-width: 420px; }
  img { width: 64px; height: 64px; }
  h1 { font-size: 1.5rem; letter-spacing: -0.02em; margin: 16px 0 8px; }
  p { color: var(--ink-2); margin: 0 0 24px; overflow-wrap: anywhere; }
  strong { color: var(--ink); font-weight: 600; }
  a { display: inline-block; padding: 12px 22px; border-radius: 999px; background: var(--ink); color: var(--bg);
    font-weight: 650; text-decoration: none; }
</style></head><body><main>
<img src="/icon.svg" alt="">
<h1>This list is private</h1>
<p>You're signed in as <strong>${escapeHtml(email)}</strong>, which doesn't have access. Ask the owner to add you, or sign in with a different account.</p>
<a href="/.freepod/auth/logout?rd=/">Sign out</a>
</main></body></html>`);
}

// Returns true when the request may proceed; otherwise it has already answered.
function authorize(req, res, pathname) {
  const email = (req.headers["x-freepod-email"] || DEV_EMAIL || "").trim().toLowerCase();
  if (!email) {
    send(res, 401, { error: "Not signed in" });
    return false;
  }
  if (ALLOWED_EMAILS.has(email)) return true;
  console.log(`access denied: ${email} ${req.method} ${pathname}`);
  if (pathname.startsWith("/api/")) send(res, 403, { error: "No access" });
  else sendDenied(res, email);
  return false;
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://x");
  const method = req.method;

  if (pathname === "/healthz") {
    await pool.query("SELECT 1");
    return send(res, 200, { ok: true });
  }

  // The page and the data are private; styles, script and icons hold neither.
  const isPage = pathname === "/" || pathname === "/index.html";
  if ((isPage || pathname.startsWith("/api/")) && !authorize(req, res, pathname)) return;

  if (pathname === "/api/items") {
    if (method === "GET") return send(res, 200, await allItems());
    if (method === "POST") return send(res, 200, await createItem(await readJson(req)));
    if (method === "PATCH") {
      const { ids, ...changes } = await readJson(req);
      return send(res, 200, await updateItems(ids, changes));
    }
  }

  let m = pathname.match(/^\/api\/items\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === "PATCH") return send(res, 200, await updateItems([id], await readJson(req)));
    if (method === "DELETE") return send(res, 200, await deleteItem(id));
  }

  m = pathname.match(/^\/api\/items\/(\d+)\/move$/);
  if (m && method === "POST") {
    const { anchor, position } = await readJson(req);
    return send(res, 200, await moveItem(Number(m[1]), anchor, position));
  }

  if (method === "GET" && (await serveStatic(pathname, res))) return;
  throw httpError(404, "Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(req.method, req.url, err);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? "Server error" : err.message });
  }
});

await migrate();
console.log(ALLOWED_EMAILS.size
  ? `access limited to ${ALLOWED_EMAILS.size} email address${ALLOWED_EMAILS.size === 1 ? "" : "es"}`
  : "MILK_ALLOWED_EMAILS is empty: every request will be refused");
server.listen(PORT, "0.0.0.0", () => console.log(`milk listening on :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
