const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Zm4 2v8h1.5v-8H10Zm2.5 0v8H14v-8h-1.5Z"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><path d="M9 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM16.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2Zm13.7-7.5a1 1 0 0 0 0-1.4L15.7 6.3a1 1 0 0 0-1.4 0l-1.5 1.5 2.8 2.8 2.1-1.9Z"/></svg>',
  basket: '<svg viewBox="0 0 24 24"><path d="M17.2 9 13 2.6l-1.7 1L15 9H9l3.7-5.4L11 2.6 6.8 9H2v2h1.2l1.9 8.6A2 2 0 0 0 7 21h10a2 2 0 0 0 2-1.4l1.9-8.6H22V9h-4.8Zm-.2 10H7l-1.8-8h13.6L17 19Z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  title: $("title"),
  subtitle: $("subtitle"),
  progress: $("progress-bar"),
  modeBtn: $("mode-btn"),
  list: $("list"),
  empty: $("empty"),
  clearDone: $("clear-done"),
  form: $("add-form"),
  query: $("query"),
  clearQuery: $("clear-query"),
  toast: $("toast"),
  toastMsg: $("toast-msg"),
  toastAction: $("toast-action"),
  hint: $("hint"),
  sortBtns: document.querySelectorAll(".segmented button"),
};

const state = {
  items: [],       // the whole catalog, in store order
  mode: "shop",    // "shop" | "edit"
  query: "",
  // Each mode remembers its own order: shopping defaults to the store's layout,
  // editing to A–Z, which is easier for finding a specific item.
  sort: { shop: loadSort("shop", "store"), edit: loadSort("edit", "alpha") },
  loaded: false,
};

function loadSort(mode, fallback) {
  try {
    const saved = localStorage.getItem(`milk.sort.${mode}`) ?? (mode === "edit" ? localStorage.getItem("milk.sort") : null);
    return saved === "store" || saved === "alpha" ? saved : fallback;
  } catch {
    return fallback;
  }
}

// Alphabetical order ignores case, accents and any leading spaces or symbols,
// so "  (Oat) milk", "oat milk" and "Öat milk" all sort under O.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const sortKey = (name) => name.replace(/^[^\p{L}\p{N}]+/u, "") || name;
const alphabetical = (a, b) => collator.compare(sortKey(a.name), sortKey(b.name)) || collator.compare(a.name, b.name);

// ---------- server sync ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let pending = 0;
let chain = Promise.resolve();
let tempId = -1;

// Apply a change locally right away, then send it. Requests run one at a time,
// and the server's answer only replaces local state once the queue is drained,
// so rapid taps never flicker back to an older state.
function mutate(applyLocally, request) {
  applyLocally();
  render();
  pending++;
  chain = chain
    .then(request)
    .then((items) => {
      if (--pending === 0) setItems(items);
    })
    .catch((err) => {
      pending--;
      showToast(err instanceof TypeError ? "Couldn't reach the server" : err.message);
      if (pending === 0) refresh();
    });
  return chain;
}

function setItems(items) {
  if (JSON.stringify(items) === JSON.stringify(state.items)) return;
  state.items = items;
  render();
}

async function refresh() {
  if (pending || drag || editing) return;
  try {
    const items = await api("GET", "/api/items");
    if (!pending && !drag && !editing) setItems(items);
    state.loaded = true;
  } catch {
    if (!state.loaded) showToast("Couldn't load your list");
  }
}

// ---------- actions ----------

const byId = (id) => state.items.find((i) => i.id === id);

function toggleDone(item) {
  const done = !item.done;
  mutate(() => { item.done = done; }, () => api("PATCH", `/api/items/${item.id}`, { done }));
  navigator.vibrate?.(8);
}

function toggleOnList(item) {
  const on_list = !item.on_list;
  mutate(
    () => { item.on_list = on_list; item.done = false; },
    () => api("PATCH", `/api/items/${item.id}`, { on_list }),
  );
}

function clearDone() {
  const ids = state.items.filter((i) => i.on_list && i.done).map((i) => i.id);
  if (!ids.length) return;
  const set = (on_list) => () => {
    for (const i of state.items) if (ids.includes(i.id)) { i.on_list = on_list; i.done = on_list; }
  };
  mutate(set(false), () => api("PATCH", "/api/items", { ids, on_list: false }));
  showToast(`Cleared ${ids.length} checked ${ids.length === 1 ? "item" : "items"}`, () =>
    mutate(set(true), () => api("PATCH", "/api/items", { ids, on_list: true, done: true })));
}

function deleteItem(item) {
  const snapshot = { ...item };
  mutate(
    () => { state.items = state.items.filter((i) => i !== item); },
    () => api("DELETE", `/api/items/${item.id}`),
  );
  showToast(`Deleted “${item.name}”`, () => {
    const restored = { ...snapshot, id: tempId-- };
    mutate(
      () => { state.items.push(restored); state.items.sort((a, b) => a.weight - b.weight); },
      () => api("POST", "/api/items", snapshot),
    );
  });
}

function addFromQuery() {
  const name = state.query.replace(/\s+/g, " ").trim();
  if (!name) return;
  const existing = state.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.on_list) showToast(`“${existing.name}” is already on the list`);
    else toggleOnList(existing);
  } else {
    const weight = Math.max(0, ...state.items.map((i) => i.weight)) + 1024;
    mutate(
      () => state.items.push({ id: tempId--, name, weight, on_list: true, done: false }),
      () => api("POST", "/api/items", { name, on_list: true }),
    );
  }
  setQuery("");
  els.query.focus();
}

function moveItem(item, anchor, position) {
  mutate(
    () => {
      const list = state.items.filter((i) => i !== item);
      const at = list.indexOf(anchor) + (position === "after" ? 1 : 0);
      list.splice(at, 0, item);
      state.items = list;
    },
    () => api("POST", `/api/items/${item.id}/move`, { anchor: anchor.id, position }),
  );
}

let editing = null; // { id, draft } while a name is being edited

function startRename(item) {
  editing = { id: item.id, draft: item.name };
  render();
  const input = els.list.querySelector(".name-input");
  input?.focus();
  input?.select();
}

function finishRename(save) {
  if (!editing) return;
  const { id, draft } = editing;
  editing = null;
  const item = byId(id);
  const name = draft.replace(/\s+/g, " ").trim();
  if (!save || !item || !name || name === item.name) return render();
  const clash = state.items.find((i) => i !== item && i.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    showToast(`“${clash.name}” already exists`);
    return render();
  }
  mutate(() => { item.name = name; }, () => api("PATCH", `/api/items/${id}`, { name }));
}

// ---------- rendering ----------

function setMode(mode) {
  state.mode = mode;
  els.body.dataset.mode = mode;
  if (mode === "shop") setQuery("");
  render();
  window.scrollTo({ top: 0 });
}

function setQuery(q) {
  state.query = q;
  els.query.value = q;
  els.clearQuery.hidden = !q;
  render();
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function nameNode(text) {
  const span = el("span", "name");
  span.textContent = text;
  return span;
}

function shopRow(item) {
  const li = el("li", `row${item.done ? " done" : ""}${item.id < 0 ? " pending" : ""}`);
  const btn = el("button", "row-main");
  btn.type = "button";
  btn.setAttribute("role", "checkbox");
  btn.setAttribute("aria-checked", String(item.done));
  btn.append(el("span", "check", ICONS.check), nameNode(item.name));
  btn.addEventListener("click", () => toggleDone(item));
  li.append(btn);
  return li;
}

function editRow(item, sortable) {
  if (editing?.id === item.id) return renameRow(item);
  const li = el("li", `row ${item.on_list ? "on" : "off"}${item.id < 0 ? " pending" : ""}`);
  li.dataset.id = item.id;

  const main = el("button", "row-main");
  main.type = "button";
  main.setAttribute("aria-pressed", String(item.on_list));
  main.title = item.on_list ? "On the list — tap to remove" : "Tap to add to the list";
  main.append(el("span", "check", item.on_list ? ICONS.check : ICONS.plus), nameNode(item.name));
  main.addEventListener("click", () => toggleOnList(item));

  const actions = el("div", "row-actions");
  const rename = el("button", "icon-btn", ICONS.pencil);
  rename.type = "button";
  rename.setAttribute("aria-label", `Rename ${item.name}`);
  rename.addEventListener("click", () => startRename(item));
  actions.append(rename);

  const del = el("button", "icon-btn del", ICONS.trash);
  del.type = "button";
  del.setAttribute("aria-label", `Delete ${item.name}`);
  del.addEventListener("click", () => deleteItem(item));
  actions.append(del);

  if (sortable) {
    const grip = el("button", "grip", ICONS.grip);
    grip.type = "button";
    grip.setAttribute("aria-label", `Reorder ${item.name}`);
    grip.addEventListener("pointerdown", (e) => startDrag(e, li, item));
    grip.addEventListener("keydown", (e) => keyboardMove(e, item));
    actions.append(grip);
  }

  li.append(main, actions);
  return li;
}

function renameRow(item) {
  const li = el("li", `row editing ${item.on_list ? "on" : "off"}`);
  li.dataset.id = item.id;
  const input = el("input", "name-input");
  Object.assign(input, { type: "text", value: editing.draft, maxLength: 80, enterKeyHint: "done" });
  input.setAttribute("aria-label", `New name for ${item.name}`);
  input.addEventListener("input", () => { editing.draft = input.value; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finishRename(true); }
    if (e.key === "Escape") finishRename(false);
  });
  input.addEventListener("blur", () => finishRename(true));

  const save = el("button", "icon-btn save", ICONS.check);
  save.type = "button";
  save.setAttribute("aria-label", "Save name");
  save.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus; the click saves
  save.addEventListener("click", () => finishRename(true));

  const actions = el("div", "row-actions");
  actions.append(save);
  li.append(el("span", "check", item.on_list ? ICONS.check : ICONS.plus), input, actions);
  return li;
}

function suggestRow(name) {
  const li = el("li", "row suggest");
  const btn = el("button", "row-main");
  btn.type = "button";
  btn.append(el("span", "check", ICONS.plus), nameNode(`Add “${name}”`));
  btn.addEventListener("click", addFromQuery);
  li.append(btn);
  return li;
}

function renderEmpty(kind) {
  els.empty.hidden = !kind;
  if (!kind) return;
  if (kind === "shop") {
    els.empty.innerHTML = `${ICONS.basket}<h2>Nothing to buy</h2><p>Your list is empty. Add what you need for this trip.</p>`;
    const btn = el("button", "pill pill-strong");
    btn.type = "button";
    btn.textContent = "Add items";
    btn.addEventListener("click", () => { setMode("edit"); els.query.focus(); });
    els.empty.append(btn);
  } else {
    els.empty.innerHTML = `${ICONS.basket}<h2>Start your catalog</h2><p>Type an item above and press Enter. Everything you add stays here for next time.</p>`;
  }
}

function render() {
  const { items, mode } = state;
  const onList = items.filter((i) => i.on_list);
  const done = onList.filter((i) => i.done).length;
  const frag = document.createDocumentFragment();

  if (mode === "shop") {
    els.title.textContent = "Shopping list";
    els.modeBtn.textContent = "Edit";
    const left = onList.length - done;
    els.subtitle.textContent = !onList.length ? "Nothing on the list"
      : left === 0 ? `All ${onList.length} in the cart`
      : `${left} to go${done ? ` · ${done} in the cart` : ""}`;
    els.progress.style.width = onList.length ? `${(done / onList.length) * 100}%` : "0";
    const sorted = state.sort.shop === "alpha" ? [...onList].sort(alphabetical) : onList;
    els.hint.textContent = "";
    sorted.forEach((i) => frag.append(shopRow(i)));
    els.clearDone.hidden = !done;
    els.clearDone.textContent = `Clear ${done} checked`;
    renderEmpty(state.loaded && !onList.length ? "shop" : null);
  } else {
    els.title.textContent = "Edit items";
    els.modeBtn.textContent = "Done";
    els.subtitle.textContent = `${onList.length} on the list · ${items.length} in the catalog`;
    const q = state.query.trim().toLowerCase().replace(/\s+/g, " ");
    let shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    if (state.sort.edit === "alpha") shown = [...shown].sort(alphabetical);
    const sortable = !q && state.sort.edit === "store";
    els.hint.innerHTML = sortable ? 'Drag <span class="grip-inline">⠿</span> to match your store' : "Tap to add or remove";
    if (q && !items.some((i) => i.name.toLowerCase() === q)) frag.append(suggestRow(state.query.trim()));
    shown.forEach((i) => frag.append(editRow(i, sortable)));
    renderEmpty(state.loaded && !items.length ? "edit" : null);
  }

  for (const b of els.sortBtns) b.setAttribute("aria-checked", String(b.dataset.sort === state.sort[mode]));
  els.list.replaceChildren(frag);
}

// ---------- drag to reorder ----------

let drag = null;

function startDrag(e, li, item) {
  if (e.button !== 0 || pending || drag) return;
  e.preventDefault();
  const rows = [...els.list.querySelectorAll(".row")];
  const from = rows.indexOf(li);
  const rect = li.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(els.list).rowGap) || 0;
  const scroll0 = window.scrollY;

  drag = {
    li, item, from,
    pointerId: e.pointerId,
    startY: e.clientY,
    lastY: e.clientY,
    scroll0,
    center0: rect.top + scroll0 + rect.height / 2,
    shift: rect.height + gap,
    others: rows.filter((r) => r !== li).map((r) => {
      const b = r.getBoundingClientRect();
      return { node: r, center: b.top + scroll0 + b.height / 2, id: Number(r.dataset.id) };
    }),
    to: from,
    raf: 0,
  };

  e.currentTarget.setPointerCapture(e.pointerId);
  e.currentTarget.addEventListener("pointermove", onDragMove);
  e.currentTarget.addEventListener("pointerup", endDrag);
  e.currentTarget.addEventListener("pointercancel", endDrag);
  document.body.classList.add("dragging");
  els.list.classList.add("sorting");
  li.classList.add("lifted");
  navigator.vibrate?.(10);
  drag.raf = requestAnimationFrame(autoScroll);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lastY = e.clientY;
  layoutDrag();
}

function layoutDrag() {
  const dy = drag.lastY - drag.startY + (window.scrollY - drag.scroll0);
  drag.li.style.transform = `translateY(${dy}px)`;
  const center = drag.center0 + dy;
  const to = drag.others.filter((o) => o.center < center).length;
  if (to !== drag.to) navigator.vibrate?.(4);
  drag.to = to;
  drag.others.forEach((o, j) => {
    const orig = j < drag.from ? j : j + 1;
    const offset = orig < drag.from && j >= to ? drag.shift
      : orig > drag.from && j < to ? -drag.shift : 0;
    o.node.style.transform = offset ? `translateY(${offset}px)` : "";
  });
}

// Scroll the page while the dragged row is held near the top or bottom edge.
function autoScroll() {
  if (!drag) return;
  const top = document.querySelector(".top").getBoundingClientRect().bottom;
  const zone = 70;
  let v = 0;
  if (drag.lastY < top + zone) v = -Math.min(1, (top + zone - drag.lastY) / zone);
  else if (drag.lastY > innerHeight - zone) v = Math.min(1, (drag.lastY - innerHeight + zone) / zone);
  if (v) {
    window.scrollBy(0, v * 14);
    layoutDrag();
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { li, item, from, to, others, raf } = drag;
  cancelAnimationFrame(raf);
  e.currentTarget.removeEventListener("pointermove", onDragMove);
  e.currentTarget.removeEventListener("pointerup", endDrag);
  e.currentTarget.removeEventListener("pointercancel", endDrag);
  drag = null;
  document.body.classList.remove("dragging");
  els.list.classList.remove("sorting");
  li.classList.remove("lifted");
  for (const r of [li, ...others.map((o) => o.node)]) r.style.transform = "";

  if (e.type === "pointercancel" || to === from || !others.length) return render();
  const [anchor, position] = to < others.length
    ? [byId(others[to].id), "before"]
    : [byId(others[others.length - 1].id), "after"];
  moveItem(item, anchor, position);
}

// Arrow keys on a focused grip move the item one step.
function keyboardMove(e, item) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const i = state.items.indexOf(item);
  const up = e.key === "ArrowUp";
  const anchor = state.items[up ? i - 1 : i + 1];
  if (!anchor) return;
  moveItem(item, anchor, up ? "before" : "after");
  requestAnimationFrame(() => els.list.querySelector(`[data-id="${item.id}"] .grip`)?.focus());
}

// ---------- toast ----------

let toastTimer;
function showToast(message, undo) {
  clearTimeout(toastTimer);
  els.toastMsg.textContent = message;
  els.toastAction.hidden = !undo;
  els.toastAction.onclick = undo ? () => { hideToast(); undo(); } : null;
  els.toast.hidden = false;
  toastTimer = setTimeout(hideToast, undo ? 6000 : 3000);
}
function hideToast() { els.toast.hidden = true; }

// ---------- wiring ----------

els.modeBtn.addEventListener("click", () => setMode(state.mode === "shop" ? "edit" : "shop"));
els.clearDone.addEventListener("click", clearDone);
for (const b of els.sortBtns) {
  b.addEventListener("click", () => {
    state.sort[state.mode] = b.dataset.sort;
    try { localStorage.setItem(`milk.sort.${state.mode}`, b.dataset.sort); } catch {}
    render();
  });
}
els.form.addEventListener("submit", (e) => { e.preventDefault(); addFromQuery(); });
els.query.addEventListener("input", () => setQuery(els.query.value));
els.query.addEventListener("keydown", (e) => { if (e.key === "Escape") setQuery(""); });
els.clearQuery.addEventListener("click", () => { setQuery(""); els.query.focus(); });

document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 10_000);

render();
refresh().then(render);
