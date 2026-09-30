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

// Headings in model responses are demoted below the column's h3 so the page outline stays intact.
const demoteHeadings = (html) => html.replace(/<(\/?)h([1-6])\b/gi, (_, slash, n) => `<${slash}h${Math.min(6, Number(n) + 3)}`);

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) return demoteHeadings(DOMPurify.sanitize(marked.parse(text || "")));
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

const badge = (text, cls = "") => `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
// A labelled list of pills, so screen readers announce each item separately.
const pillList = (label, pills) =>
  `<ul class="pill-list" aria-label="${escapeHtml(label)}">${pills.map((p) => `<li>${p}</li>`).join("")}</ul>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const BASE_TITLE = document.title;
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
    `<button type="button" data-test="${escapeHtml(t.id)}" aria-pressed="${t.id === state.test.id}">
      <strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(t.description)}</span></button>`).join("");
}

// Each prompt is a button; only the selected one is in the tab order and arrow keys move between them.
function renderList(focus = false) {
  const count = `${state.filtered.length} of ${state.records.length} ${state.test.has_attempts ? "attempts" : "prompts"}`;
  if (els.count.textContent !== count) els.count.textContent = count;
  els.list.innerHTML = state.filtered.map((r) => {
    const n = r.errors.length;
    const current = r.id === state.selected;
    return `<li class="${current ? "selected" : ""}">
      <button type="button" data-id="${escapeHtml(r.id)}" tabindex="${current ? 0 : -1}" ${current ? 'aria-current="true"' : ""}>
        <span class="li-head">
          <span class="li-id">${escapeHtml(r.id)}${r.attempt !== null ? ` · attempt ${r.attempt + 1}` : ""}</span>
          ${n ? `<span class="err-count">${plural(n, "error")}</span>` : `<span class="ok-count">no errors</span>`}
        </span>
        <span class="li-dataset">${escapeHtml(r.dataset)}</span>
        <span class="li-prompt">${escapeHtml(r.prompt)}</span>
      </button>
    </li>`;
  }).join("");
  const sel = els.list.querySelector("li.selected button");
  if (sel) {
    // Scroll the list itself: scrollIntoView() also moves Chrome's Tab starting point into the page.
    const item = sel.parentElement, list = els.list;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
    if (focus) sel.focus();
  }
}

function renderDetail() {
  const idx = state.filtered.findIndex((r) => r.id === state.selected);
  const r = state.filtered[idx];
  if (!r) {
    document.title = BASE_TITLE;
    els.detail.innerHTML = `<p class="empty">Nothing matches these filters.</p>`;
    return;
  }

  // Attempts of the same prompt (Test B): tabs, with the matching ones marked.
  const siblings = r.attempt === null ? [] :
    state.records.filter((x) => x.group === r.group).sort((a, b) => a.attempt - b.attempt);
  const inFilter = new Set(state.filtered.map((x) => x.id));
  const tabs = siblings.length > 1 ? `<div class="tabs" role="group" aria-label="Attempts">${siblings.map((s) =>
    `<button type="button" data-id="${escapeHtml(s.id)}" class="${s.id === r.id ? "active" : ""} ${inFilter.has(s.id) ? "" : "dim"}"
      aria-pressed="${s.id === r.id}" title="${inFilter.has(s.id) ? "" : "Doesn't match the current filters"}">
      Attempt ${s.attempt + 1} <span class="tab-err">· ${s.errors.length ? plural(s.errors.length, "error") : "no errors"}</span>${inFilter.has(s.id) ? "" : `<span class="visually-hidden"> (doesn't match the current filters)</span>`}
    </button>`).join("")}</div>` : "";

  const facetRows = state.test.facets
    .filter((f) => r.facets[f.name] && r.facets[f.name] !== "(blank)")
    .map((f) => `<div class="facet"><dt class="meta-label">${escapeHtml(f.name)}</dt><dd>${badge(r.facets[f.name])}</dd></div>`).join("");

  // In-code errors: one red "Unresolved" pill if uncorrected, otherwise each shown as "Resolved" in green.
  const UNCORRECTED = "Uncorrected In-code error";
  const isInCode = (e) => /^In-code Error/i.test(e);
  // Chart description and inference errors are shown in orange under their own label, other errors in red.
  const isChartText = (e) => /^Chart (Description|Inference) Error/i.test(e);
  const codeErrors = r.errors.includes(UNCORRECTED)
    ? [badge("Unresolved In-code error", "error"),
       ...r.errors.filter((e) => e !== UNCORRECTED && !isInCode(e) && !isChartText(e)).map((e) => badge(e, "error"))]
    : r.errors.filter((e) => !isChartText(e))
        .map((e) => isInCode(e) ? badge("Resolved " + e.replace(/^(In-code Error):/i, "$1"), "ok") : badge(e, "error"));
  const chartTextErrors = r.errors.filter(isChartText).map((e) => badge(e, "warn"));
  const errorGroup = (label, pills) => pills.length
    ? `<div class="meta-row error-group"><span class="meta-sublabel" aria-hidden="true">${label}</span>${pillList(label, pills)}</div>` : "";

  const design = Object.entries(r.design);
  const texts = r.responses.filter((x) => x.type === "text");
  const codes = r.responses.filter((x) => x.type === "code");
  const charts = r.responses.filter((x) => x.type === "chart");

  document.title = `${r.id} – ${BASE_TITLE}`;
  els.detail.setAttribute("aria-label", `Selected prompt: ${r.id}`);
  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-id">${escapeHtml(state.test.name)} · ID ${escapeHtml(r.id)} · ${escapeHtml(r.dataset)} · ${idx + 1} of ${state.filtered.length}</div>
        <h2 id="detail-heading" tabindex="-1">${escapeHtml(r.prompt)}</h2>
      </div>
      <div class="nav-buttons">
        <button type="button" data-nav="-1" ${idx === 0 ? "disabled" : ""}><span aria-hidden="true">← </span>Previous<span class="visually-hidden"> prompt</span></button>
        <button type="button" data-nav="1" ${idx === state.filtered.length - 1 ? "disabled" : ""}>Next<span class="visually-hidden"> prompt</span><span aria-hidden="true"> →</span></button>
      </div>
    </div>
    ${tabs}
    <div class="coding">
      <h3 class="meta-label">Errors</h3>
      ${r.errors.length
        ? errorGroup("Data and code", codeErrors) + errorGroup("Chart description and inference", chartTextErrors)
        : `<div class="meta-row">${badge("No errors", "ok")}</div>`}
      ${design.length ? `<div class="design-list"><h3 class="meta-label">Design issues</h3>
        <ul class="design-items">${design.map(([k, v]) => `<li class="design-item">${badge(k, "design")}<div class="design-text" tabindex="0" role="region" aria-label="${escapeHtml(k)} details">${escapeHtml(v)}</div></li>`).join("")}</ul></div>` : ""}
      <details class="facets-box">
        <summary>Characteristics</summary>
        <dl class="facet-grid">${facetRows}</dl>
      </details>
      ${r.operations.length ? `<div class="meta-row"><h3 class="meta-label">Code operations</h3>${pillList("Code operations", r.operations.map((o) => badge(o, "op")))}</div>` : ""}
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
        ${codes.length ? codes.map((x, i) => `<pre class="code-block" tabindex="0" role="region" aria-label="Code block ${i + 1} of ${codes.length}"><code class="language-python">${escapeHtml(x.content)}</code></pre>`).join("")
          : `<p class="empty">No code.</p>`}
      </section>
      <section class="column">
        <h3>Charts (${charts.length})</h3>
        ${charts.length ? charts.map((x, i) => x.content
            ? `<div class="chart-block"><a href="${escapeHtml(x.content)}" target="_blank" rel="noopener"><img class="chart-img" loading="lazy" src="${escapeHtml(x.content)}" alt="Chart ${i + 1} of ${charts.length} for ${escapeHtml(r.id)}. Chart information follows."></a><details class="chart-data" open>
              <summary>Chart information (data values unavailable)</summary>
              <table>
                <caption>Chart information for prompt ${escapeHtml(r.id)}, image ${i + 1}</caption>
                <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Dataset</th><td>${escapeHtml(r.dataset)}</td></tr>
                  <tr><th scope="row">Data values</th><td>Not included in the exported chart data. The plotted values are not available in this viewer.</td></tr>
                </tbody>
              </table>
            </details></div>`
            : `<p class="missing">Image missing: ${escapeHtml(x.missing)}</p>`).join("")
          : `<p class="empty">No chart generated.</p>`}
      </section>
    </div>`;

  const box = els.detail.querySelector(".facets-box");
  try { box.open = localStorage.getItem("facetsOpen") !== "0"; } catch {}
  box.addEventListener("toggle", () => { try { localStorage.setItem("facetsOpen", box.open ? "1" : "0"); } catch {} });
  if (window.hljs) els.detail.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
}

// focus: "list" keeps focus on the list, "heading" moves to the prompt's heading, or a CSS selector
// for a control inside the detail view that should keep focus after it is re-rendered.
function select(id, focus = null) {
  state.selected = id;
  renderList(focus === "list");
  renderDetail();
  writeHash();
  if (focus && focus !== "list") {
    const target = focus === "heading" ? $("detail-heading") : els.detail.querySelector(focus);
    (target && !target.disabled ? target : $("detail-heading"))?.focus();
  }
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
  const b = e.target.closest("button[data-id]");
  if (b) select(b.dataset.id, e.detail === 0 ? "heading" : "list");  // keyboard activation moves to the prompt
});

els.list.addEventListener("keydown", (e) => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const all = state.filtered;
  let idx = null;
  if (step) idx = all.findIndex((r) => r.id === state.selected) + step;
  if (e.key === "Home") idx = 0;
  if (e.key === "End") idx = all.length - 1;
  if (idx === null) return;
  e.preventDefault();
  if (all[idx]) select(all[idx].id, "list");
});

els.detail.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const idx = state.filtered.findIndex((r) => r.id === state.selected) + Number(nav.dataset.nav);
    if (state.filtered[idx]) select(state.filtered[idx].id, `[data-nav="${nav.dataset.nav}"]`);
    els.detail.scrollTop = 0;
    return;
  }
  const tab = e.target.closest(".tabs [data-id]");
  if (tab) {
    const focus = `.tabs [data-id="${CSS.escape(tab.dataset.id)}"]`;
    // Showing an attempt outside the current filters would hide it from the list; clear filters first.
    if (state.filtered.some((r) => r.id === tab.dataset.id)) return select(tab.dataset.id, focus);
    clearFilters(false);
    state.selected = tab.dataset.id;
    applyFilters();
    els.detail.querySelector(focus)?.focus();
  }
});

// j/k move between prompts from anywhere except text fields. Arrow keys are left alone outside the list
// so they still scroll the page.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const step = { j: 1, k: -1 }[e.key];
  if (!step) return;
  const idx = state.filtered.findIndex((r) => r.id === state.selected) + step;
  if (state.filtered[idx]) { e.preventDefault(); select(state.filtered[idx].id, els.list.contains(document.activeElement) ? "list"
    : els.detail.contains(document.activeElement) ? "heading" : null); }
});

// Skip links move focus without touching the URL hash, which holds the filter state.
document.querySelector(".skip-links").addEventListener("click", (e) => {
  const a = e.target.closest("[data-skip]");
  if (!a) return;
  e.preventDefault();
  const target = a.dataset.skip === "list" ? els.list.querySelector("button[tabindex='0']") || els.list : $("detail-heading") || els.detail;
  target.focus();
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

const abstract = $("abstract");
// On narrow screens the abstract scrolls in its own box, so it needs to be reachable by keyboard.
const narrow = matchMedia("(max-width: 800px)");
const syncAbstractFocus = () => narrow.matches ? $("abstract-text").setAttribute("tabindex", "0") : $("abstract-text").removeAttribute("tabindex");
syncAbstractFocus();
narrow.addEventListener("change", syncAbstractFocus);
try { if (localStorage.getItem("abstractOpen") === "0") abstract.open = false; } catch {}
abstract.addEventListener("toggle", () => {
  try { localStorage.setItem("abstractOpen", abstract.open ? "1" : "0"); } catch {}
});

async function init() {
  try {
    state.index = await fetch("data/index.json").then((r) => r.json());
    $("title").textContent = state.index.title;
    const params = readHash();
    await loadTest(params.get("t") || state.index.tests[0].id, params);
  } catch (err) {
    els.detail.innerHTML = `<p class="missing">Could not load data (${escapeHtml(err.message)}).
      If you opened index.html directly, serve the folder instead: <code>python3 -m http.server -d docs 8000</code></p>`;
  }
}

init();
