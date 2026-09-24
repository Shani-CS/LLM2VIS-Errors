// Static viewer for LLM-produced visualizations and their coded errors.
// Data is produced by build_data.py; filter state lives in the URL hash so views can be shared.

const ALL = "__all__";

const state = {
  index: null,        // data/index.json
  test: null,         // current test metadata
  records: [],        // records of the current test
  cache: {},          // test id -> records
  filtered: [],
  selected: null,     // record id
};

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $("test-toggle"),
  search: $("f-search"),
  dataset: $("f-dataset"),
  error: $("f-error"),
  more: $("f-more"),
  clear: $("f-clear"),
  facets: $("facet-filters"),
  list: $("prompt-list"),
  count: $("list-count"),
  detail: $("detail"),
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || ""));
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

const badge = (text, cls = "") => `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
const facetSelects = () => [...els.facets.querySelectorAll("select[data-facet]")];

// ---------- URL hash ----------

function readHash() {
  return new URLSearchParams(location.hash.slice(1));
}

function writeHash() {
  const p = new URLSearchParams();
  p.set("t", state.test.id);
  if (els.search.value) p.set("q", els.search.value);
  if (els.dataset.value !== ALL) p.set("ds", els.dataset.value);
  if (els.error.value !== ALL) p.set("err", els.error.value);
  for (const s of facetSelects()) if (s.value !== ALL) p.set("f." + s.dataset.facet, s.value);
  if (state.selected) p.set("p", state.selected);
  history.replaceState(null, "", "#" + p.toString());
}

// ---------- Filter controls ----------

function options(values, counts, allLabel) {
  return [`<option value="${ALL}">${escapeHtml(allLabel)}</option>`,
    ...values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts.get(v) || 0})</option>`)].join("");
}

function countValues(fn) {
  const counts = new Map();
  for (const r of state.records) for (const v of fn(r)) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

function buildControls(params) {
  const t = state.test;
  els.dataset.innerHTML = options(t.datasets, countValues((r) => [r.dataset]), "All datasets");

  const errCounts = countValues((r) => r.errors);
  const designCounts = countValues((r) => Object.keys(r.design));
  const anyError = state.records.filter((r) => r.errors.length).length;
  const anyDesign = state.records.filter((r) => Object.keys(r.design).length).length;
  const opt = (value, label, n) => `<option value="${escapeHtml(value)}">${escapeHtml(label)} (${n})</option>`;
  els.error.innerHTML = [
    `<option value="${ALL}">All (errors or not)</option>`,
    `<optgroup label="Summary">`,
    opt("any:error", "Any error", anyError),
    opt("none:error", "No errors", state.records.length - anyError),
    opt("any:design", "Any design issue", anyDesign),
    `</optgroup><optgroup label="Error types">`,
    ...t.errors.map((e) => opt("error:" + e, e, errCounts.get(e) || 0)),
    `</optgroup><optgroup label="Design issues">`,
    ...t.design.map((d) => opt("design:" + d, d, designCounts.get(d) || 0)),
    `</optgroup>`,
  ].join("");

  els.facets.innerHTML = t.facets.map((f) => {
    const counts = countValues((r) => [r.facets[f.name]]);
    return `<label>${escapeHtml(f.name)}
      <select data-facet="${escapeHtml(f.name)}">${options(f.values, counts, "All")}</select></label>`;
  }).join("");

  const setValue = (el, v) => { el.value = v && [...el.options].some((o) => o.value === v) ? v : ALL; };
  els.search.value = params.get("q") || "";
  setValue(els.dataset, params.get("ds"));
  setValue(els.error, params.get("err"));
  for (const s of facetSelects()) setValue(s, params.get("f." + s.dataset.facet));
  if (facetSelects().some((s) => s.value !== ALL)) toggleMore(true);
  state.selected = params.get("p");
}

function toggleMore(open = els.facets.hidden) {
  els.facets.hidden = !open;
  els.more.setAttribute("aria-expanded", String(open));
  updateMoreLabel();
}

function updateMoreLabel() {
  const active = facetSelects().filter((s) => s.value !== ALL).length;
  els.more.textContent = (els.facets.hidden ? "More filters" : "Fewer filters") + (active ? ` (${active})` : "");
}

// ---------- Filtering ----------

function matches(r) {
  const q = els.search.value.trim().toLowerCase();
  if (q && !(r.prompt.toLowerCase().includes(q) || r.id.toLowerCase() === q || r.id.toLowerCase().startsWith(q + "-"))) return false;
  if (els.dataset.value !== ALL && r.dataset !== els.dataset.value) return false;

  const e = els.error.value;
  if (e !== ALL) {
    const [kind, name] = [e.slice(0, e.indexOf(":")), e.slice(e.indexOf(":") + 1)];
    if (kind === "any" && name === "error" && !r.errors.length) return false;
    if (kind === "none" && r.errors.length) return false;
    if (kind === "any" && name === "design" && !Object.keys(r.design).length) return false;
    if (kind === "error" && !r.errors.includes(name)) return false;
    if (kind === "design" && !(name in r.design)) return false;
  }
  for (const s of facetSelects()) {
    if (s.value !== ALL && r.facets[s.dataset.facet] !== s.value) return false;
  }
  return true;
}

function applyFilters() {
  state.filtered = state.records.filter(matches);
  if (!state.filtered.some((r) => r.id === state.selected)) {
    state.selected = state.filtered.length ? state.filtered[0].id : null;
  }
  updateMoreLabel();
  renderList();
  renderDetail();
  writeHash();
}

// ---------- Rendering ----------

function renderToggle() {
  els.toggle.innerHTML = state.index.tests.map((t) =>
    `<button type="button" role="tab" data-test="${escapeHtml(t.id)}" aria-selected="${t.id === state.test.id}"
      title="${escapeHtml(t.description)}">
      <strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(t.description)}</span></button>`).join("");
}

function renderList() {
  els.count.textContent = `${state.filtered.length} of ${state.records.length} ${state.test.has_attempts ? "attempts" : "prompts"}`;
  els.list.innerHTML = state.filtered.map((r) => {
    const n = r.errors.length;
    return `<li data-id="${escapeHtml(r.id)}" class="${r.id === state.selected ? "selected" : ""}">
      <div class="li-head">
        <span class="li-id">${escapeHtml(r.id)}${r.attempt !== null ? ` · attempt ${r.attempt + 1}` : ""}</span>
        ${n ? `<span class="err-count">${n} error${n > 1 ? "s" : ""}</span>` : `<span class="ok-count">no errors</span>`}
      </div>
      <div class="li-dataset">${escapeHtml(r.dataset)}</div>
      <div class="li-prompt">${escapeHtml(r.prompt)}</div>
    </li>`;
  }).join("");
  const sel = els.list.querySelector("li.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function renderDetail() {
  const idx = state.filtered.findIndex((r) => r.id === state.selected);
  const r = state.filtered[idx];
  if (!r) {
    els.detail.innerHTML = `<p class="empty">Nothing matches these filters.</p>`;
    return;
  }

  // Attempts of the same prompt (Test B): tabs, with the matching ones marked.
  const siblings = r.attempt === null ? [] :
    state.records.filter((x) => x.group === r.group).sort((a, b) => a.attempt - b.attempt);
  const inFilter = new Set(state.filtered.map((x) => x.id));
  const tabs = siblings.length > 1 ? `<div class="tabs">${siblings.map((s) =>
    `<button type="button" data-id="${escapeHtml(s.id)}" class="${s.id === r.id ? "active" : ""} ${inFilter.has(s.id) ? "" : "dim"}"
      title="${inFilter.has(s.id) ? "" : "Doesn't match the current filters"}">
      Attempt ${s.attempt + 1} <span class="tab-err">${s.errors.length ? `· ${s.errors.length} error${s.errors.length > 1 ? "s" : ""}` : "· no errors"}</span>
    </button>`).join("")}</div>` : "";

  const facetRows = state.test.facets
    .filter((f) => r.facets[f.name] && r.facets[f.name] !== "(blank)")
    .map((f) => `<div class="facet"><span class="meta-label">${escapeHtml(f.name)}</span>${badge(r.facets[f.name])}</div>`).join("");

  const design = Object.entries(r.design);
  const texts = r.responses.filter((x) => x.type === "text");
  const codes = r.responses.filter((x) => x.type === "code");
  const charts = r.responses.filter((x) => x.type === "chart");

  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-id">${escapeHtml(state.test.name)} · ID ${escapeHtml(r.id)} · ${escapeHtml(r.dataset)} · ${idx + 1} of ${state.filtered.length}</div>
        <h2>${escapeHtml(r.prompt)}</h2>
      </div>
      <div class="nav-buttons">
        <button type="button" data-nav="-1" ${idx === 0 ? "disabled" : ""}>← Previous</button>
        <button type="button" data-nav="1" ${idx === state.filtered.length - 1 ? "disabled" : ""}>Next →</button>
      </div>
    </div>
    ${tabs}
    <div class="coding">
      <div class="meta-row"><span class="meta-label">Errors</span>${r.errors.length
        ? r.errors.map((e) => badge(e, "error")).join("") : badge("No errors", "ok")}</div>
      ${design.length ? `<div class="design-list"><span class="meta-label">Design issues</span>
        ${design.map(([k, v]) => `<div class="design-item">${badge(k, "design")}<div class="design-text">${escapeHtml(v)}</div></div>`).join("")}</div>` : ""}
      <details class="facets-box">
        <summary>Characteristics</summary>
        <div class="facet-grid">${facetRows}</div>
      </details>
      ${r.operations.length ? `<div class="meta-row"><span class="meta-label">Code operations</span>${r.operations.map((o) => badge(o, "op")).join("")}</div>` : ""}
    </div>
    ${r.has_results ? "" : `<p class="missing">No model output was found for this ID.</p>`}
    <div class="columns">
      <section class="column">
        <h3>Text responses (${texts.length})</h3>
        ${texts.length ? texts.map((x) => `<div class="text-block">${renderMarkdown(x.content)}</div>`).join("")
          : `<p class="empty">No text response.</p>`}
      </section>
      <section class="column">
        <h3>Code (${codes.length})</h3>
        ${codes.length ? codes.map((x) => `<pre class="code-block"><code class="language-python">${escapeHtml(x.content)}</code></pre>`).join("")
          : `<p class="empty">No code.</p>`}
      </section>
      <section class="column">
        <h3>Charts (${charts.length})</h3>
        ${charts.length ? charts.map((x) => x.content
            ? `<a href="${escapeHtml(x.content)}" target="_blank" rel="noopener"><img class="chart-img" loading="lazy" src="${escapeHtml(x.content)}" alt="Chart generated for ${escapeHtml(r.id)}"></a>`
            : `<p class="missing">Image missing: ${escapeHtml(x.missing)}</p>`).join("")
          : `<p class="empty">No chart generated.</p>`}
      </section>
    </div>`;

  const box = els.detail.querySelector(".facets-box");
  box.open = localStorage.getItem("facetsOpen") !== "0";
  box.addEventListener("toggle", () => localStorage.setItem("facetsOpen", box.open ? "1" : "0"));
  if (window.hljs) els.detail.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
}

function select(id) {
  state.selected = id;
  renderList();
  renderDetail();
  writeHash();
}

// ---------- Tests ----------

async function loadTest(testId, params = new URLSearchParams()) {
  state.test = state.index.tests.find((t) => t.id === testId) || state.index.tests[0];
  if (!state.cache[state.test.id]) {
    state.cache[state.test.id] = await fetch(`data/test-${state.test.id}.json`).then((r) => r.json());
  }
  state.records = state.cache[state.test.id];
  renderToggle();
  buildControls(params);
  applyFilters();
}

// ---------- Events ----------

els.toggle.addEventListener("click", (e) => {
  const b = e.target.closest("[data-test]");
  if (b && b.dataset.test !== state.test.id) loadTest(b.dataset.test);
});

els.list.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id);
});

els.detail.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const idx = state.filtered.findIndex((r) => r.id === state.selected) + Number(nav.dataset.nav);
    if (state.filtered[idx]) select(state.filtered[idx].id);
    els.detail.scrollTop = 0;
    return;
  }
  const tab = e.target.closest(".tabs [data-id]");
  if (tab) {
    // Showing an attempt outside the current filters would hide it from the list; clear filters first.
    if (state.filtered.some((r) => r.id === tab.dataset.id)) return select(tab.dataset.id);
    clearFilters(false);
    state.selected = tab.dataset.id;
    applyFilters();
  }
});

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
  if (!step) return;
  const idx = state.filtered.findIndex((r) => r.id === state.selected) + step;
  if (state.filtered[idx]) { e.preventDefault(); select(state.filtered[idx].id); }
});

function clearFilters(apply = true) {
  els.search.value = "";
  els.dataset.value = els.error.value = ALL;
  for (const s of facetSelects()) s.value = ALL;
  if (apply) applyFilters();
}

els.search.addEventListener("input", applyFilters);
els.dataset.addEventListener("change", applyFilters);
els.error.addEventListener("change", applyFilters);
els.facets.addEventListener("change", applyFilters);
els.more.addEventListener("click", () => toggleMore());
els.clear.addEventListener("click", () => clearFilters());

// ---------- Init ----------

async function init() {
  try {
    state.index = await fetch("data/index.json").then((r) => r.json());
    document.title = state.index.title;
    $("title").textContent = state.index.title;
    const params = readHash();
    await loadTest(params.get("t") || state.index.tests[0].id, params);
  } catch (err) {
    els.detail.innerHTML = `<p class="missing">Could not load data (${escapeHtml(err.message)}).
      If you opened index.html directly, serve the folder instead: <code>python3 -m http.server -d docs 8000</code></p>`;
  }
}

init();
