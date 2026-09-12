// QAQC 前端 v3 — 對應分層式後端 API
// 核心概念：assay = 儀器 × 檢驗項目 × 檢體別；品管判讀一律綁儀器。

const API = "";

/* ==================================================================== 基礎 */
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 16);

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = body && body.detail;
    throw new Error(
      typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map((d) => `${(d.loc || []).slice(-1)}: ${d.msg}`).join("；")
          : (text || res.statusText)
    );
  }
  return body;
}

const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (p, b) => api(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const put = (p, b) => api(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const del = (p) => api(p, { method: "DELETE" });

let toastTimer;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.className = "toast " + type;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function setMsg(id, text, cls = "") {
  const el = document.getElementById(id);
  if (el) { el.className = "add-msg " + cls; el.textContent = text; }
}

/* ============================================================ 導覽與主題 */
const views = document.querySelectorAll(".view");
const navLinks = document.querySelectorAll(".nav-link[data-view]");

const VIEW_INIT = {};          // view 名稱 → 首次進入時要執行的函式
const VIEW_LOADED = new Set();

navLinks.forEach((t) => {
  t.addEventListener("click", () => {
    if (t.classList.contains("disabled")) return;
    navLinks.forEach((x) => x.classList.remove("active"));
    views.forEach((v) => v.classList.remove("active"));
    t.classList.add("active");
    const name = t.dataset.view;
    document.getElementById("view-" + name).classList.add("active");
    const fn = VIEW_INIT[name];
    if (fn) {
      if (!VIEW_LOADED.has(name)) { VIEW_LOADED.add(name); fn(true); }
      else fn(false);
    }
  });
});

document.querySelectorAll(".nav-group-title").forEach((btn) =>
  btn.addEventListener("click", () => btn.parentElement.classList.toggle("open")));
document.getElementById("sidebar-toggle").addEventListener("click", () =>
  document.querySelector(".layout").classList.toggle("sidebar-collapsed"));

const themeToggle = document.getElementById("theme-toggle");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  localStorage.setItem("qaqc-theme", theme);
  if (window.__redrawER) window.__redrawER();
  if (window.__redrawLJ) window.__redrawLJ();
}
themeToggle.addEventListener("change", () => applyTheme(themeToggle.checked ? "light" : "dark"));
applyTheme(localStorage.getItem("qaqc-theme") || "dark");

/* ==================================================== 共用主檔（快取） */
let SECTIONS = [], INSTRUMENTS = [], SPECIMENS = [];

async function loadMasters() {
  [SECTIONS, SPECIMENS] = await Promise.all([
    api("/api/sections"), api("/api/specimen-types"),
  ]);
  INSTRUMENTS = (await api("/api/instruments?include_inactive=true")).all;
  refreshSelectors();
}

// 所有「組別 → 儀器」連動選單
const CASCADES = [
  ["run-section", "run-instrument", false],
  ["res-section", "res-instrument", true],
  ["lj-section", "lj-instrument", false],
  ["cal-section", "cal-instrument", true],
  ["assay-section", "assay-instrument", false],
  ["target-section", "target-instrument", true],
  ["er-section", "er-instrument", false],
  ["load-section", "load-instrument", true],
  ["ai-section", "ai-instrument", true],
];

function fillInstruments(selectId, sectionName, includeAll) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const prev = sel.value;
  const list = INSTRUMENTS.filter((i) => !sectionName || i.section_name === sectionName);
  sel.innerHTML = (includeAll ? `<option value="">全部儀器</option>` : "") +
    list.map((i) => `<option value="${esc(i.serial_number)}">${esc(i.instrument_name)}（${esc(i.instrument_role)}）· ${esc(i.serial_number)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function refreshSelectors() {
  CASCADES.forEach(([secId, instId, all]) => {
    const sel = document.getElementById(secId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = (all ? `<option value="">全部組別</option>` : "") +
      SECTIONS.map((s) => `<option value="${esc(s.section_name)}">${esc(s.section_name)}</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    fillInstruments(instId, sel.value, all);
  });
  const sp = document.getElementById("assay-specimen");
  if (sp) {
    const prev = sp.value;
    sp.innerHTML = `<option value="">全部檢體</option>` +
      SPECIMENS.map((s) => `<option value="${esc(s.specimen_code)}">${esc(s.specimen_code)}（${esc(s.specimen_name)}）</option>`).join("");
    sp.value = prev;
  }
}

CASCADES.forEach(([secId, instId, all]) => {
  const sel = document.getElementById(secId);
  if (sel) sel.addEventListener("change", () => fillInstruments(instId, sel.value, all));
});

/* ==================================================== 通用表格渲染 */
// columns: [{key, label, render?(row), cls?}]；actions: (row) => [{label, cls, onClick}]
function renderTable(tableId, columns, rows, actions, emptyText = "無資料") {
  const table = document.getElementById(tableId);
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = "<tr>" + columns.map((c) => `<th>${esc(c.label)}</th>`).join("") +
    (actions ? "<th>操作</th>" : "") + "</tr>";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${columns.length + (actions ? 1 : 0)}" class="empty">${esc(emptyText)}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row, i) =>
    "<tr>" + columns.map((c) => {
      const v = c.render ? c.render(row) : esc(row[c.key] ?? "");
      return `<td class="${c.cls || ""}">${v}</td>`;
    }).join("") +
    (actions ? `<td><div class="row-actions" data-row="${i}"></div></td>` : "") + "</tr>"
  ).join("");
  if (!actions) return;
  tbody.querySelectorAll(".row-actions").forEach((box) => {
    const row = rows[Number(box.dataset.row)];
    actions(row).forEach((a) => {
      const b = document.createElement("button");
      b.className = "btn-xs " + (a.cls || "");
      b.textContent = a.label;
      b.addEventListener("click", a.onClick);
      box.appendChild(b);
    });
  });
}

const pill = (on, yes, no) => `<span class="state-pill ${on ? "on" : "off"}">${on ? yes : no}</span>`;
const activePill = (r) => pill(r.active !== 0 && r.active !== false, "啟用", "停用");

/* ==================================================== 通用對話框 */
const Modal = (() => {
  const back = document.getElementById("modal");
  const form = document.getElementById("modal-form");
  let current = null;

  function close() { back.classList.remove("open"); current = null; }

  function fieldHtml(f, val) {
    const id = `mf-${f.name}`;
    const req = f.required ? "required" : "";
    const full = f.full ? "full" : "";
    if (f.type === "checkbox")
      return `<label class="check-label"><input type="checkbox" id="${id}" ${val ? "checked" : ""} />${esc(f.label)}</label>`;
    if (f.type === "select")
      return `<label class="${full}">${esc(f.label)}<select id="${id}" ${req}>` +
        (f.allowEmpty ? `<option value="">（不指定）</option>` : "") +
        (f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(val ?? "") ? "selected" : ""}>${esc(o.label)}</option>`).join("") +
        `</select></label>`;
    if (f.type === "multiselect")
      return `<fieldset class="full check-group"><legend>${esc(f.label)}</legend><div id="${id}"></div></fieldset>`;
    if (f.type === "textarea")
      return `<label class="full">${esc(f.label)}<textarea id="${id}" rows="3">${esc(val ?? "")}</textarea></label>`;
    const t = f.type || "text";
    const step = t === "number" ? ' step="any"' : "";
    return `<label class="${full}">${esc(f.label)}<input type="${t}" id="${id}" value="${esc(val ?? "")}"${step} ${req} placeholder="${esc(f.placeholder || "")}" /></label>`;
  }

  function open({ title, hint, fields, values = {}, saveLabel = "儲存", onSave }) {
    current = { fields, onSave };
    document.getElementById("modal-title").textContent = title;
    const hintEl = document.getElementById("modal-hint");
    hintEl.hidden = !hint;
    if (hint) hintEl.innerHTML = hint;
    document.getElementById("modal-msg").textContent = "";
    document.getElementById("modal-save").textContent = saveLabel;
    form.innerHTML = fields.map((f) => fieldHtml(f, values[f.name])).join("");
    back.classList.add("open");
    // multiselect 需於 DOM 就緒後渲染
    fields.filter((f) => f.type === "multiselect").forEach((f) =>
      msRender(`mf-${f.name}`, f.options || [], f.emptyText || "（無可選項目）", values[f.name] || []));
    const first = form.querySelector("input:not([type=checkbox]), select");
    if (first) setTimeout(() => first.focus(), 30);
  }

  function collect() {
    const out = {};
    current.fields.forEach((f) => {
      const el = document.getElementById(`mf-${f.name}`);
      if (!el) return;
      if (f.type === "checkbox") out[f.name] = el.checked;
      else if (f.type === "multiselect") out[f.name] = checkedLinks(`mf-${f.name}`);
      else {
        const v = el.value.trim();
        out[f.name] = v === "" ? null : (f.type === "number" ? parseFloat(v) : v);
      }
    });
    return out;
  }

  document.getElementById("modal-save").addEventListener("click", async () => {
    if (!current) return;
    if (!form.reportValidity()) return;
    const btn = document.getElementById("modal-save");
    btn.disabled = true;
    setMsg("modal-msg", "儲存中…");
    try {
      await current.onSave(collect());
      close();
    } catch (e) {
      setMsg("modal-msg", "❌ " + e.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("modal-close").addEventListener("click", close);
  document.getElementById("modal-cancel").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && back.classList.contains("open")) close();
  });

  return { open, close };
})();

/* ==================================================== 可檢索下拉複選 */
function msRender(containerId, options, placeholder = "（無可選項目）", selected = []) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.classList.add("ms");
  if (!options.length) {
    box.classList.remove("ms");
    box.innerHTML = `<span class="check-empty">${esc(placeholder)}</span>`;
    return;
  }
  const picked = new Set((selected || []).map(String));
  box.innerHTML = `
    <button type="button" class="ms-toggle">
      <span class="ms-label empty">請選擇…</span>
      <span class="ms-count" hidden>0</span><span class="ms-caret">▾</span>
    </button>
    <div class="ms-panel">
      <div class="ms-search-wrap"><input type="text" class="ms-search" placeholder="輸入關鍵字檢索…" /></div>
      <div class="ms-bulk">
        <button type="button" data-all>全選（符合檢索）</button>
        <button type="button" data-none>清除選取</button>
        <span class="ms-shown"></span>
      </div>
      <div class="ms-options">${options.map((o) =>
        `<label data-text="${esc((o.label || "").toLowerCase())}" data-raw="${esc(o.label)}">
           <input type="checkbox" data-link value="${esc(o.value)}" ${picked.has(String(o.value)) ? "checked" : ""} />
           <span>${esc(o.label)}</span></label>`).join("")}
      </div>
    </div>`;

  const toggle = box.querySelector(".ms-toggle");
  const panel = box.querySelector(".ms-panel");
  const search = box.querySelector(".ms-search");
  const labels = [...box.querySelectorAll(".ms-options label")];
  const shown = box.querySelector(".ms-shown");
  let active = -1;

  const refresh = () => {
    const sel = [...box.querySelectorAll("[data-link]:checked")];
    const lab = box.querySelector(".ms-label");
    const cnt = box.querySelector(".ms-count");
    if (sel.length) {
      lab.textContent = sel.map((c) => c.parentElement.dataset.raw).join("、");
      lab.classList.remove("empty"); cnt.hidden = false; cnt.textContent = sel.length;
    } else {
      lab.textContent = "請選擇…"; lab.classList.add("empty"); cnt.hidden = true;
    }
  };
  const visible = () => labels.filter((l) => !l.hidden);
  const setActive = (i) => {
    const vis = visible();
    labels.forEach((l) => l.classList.remove("ms-active"));
    if (!vis.length) { active = -1; return; }
    active = Math.max(0, Math.min(i, vis.length - 1));
    vis[active].classList.add("ms-active");
    vis[active].scrollIntoView({ block: "nearest" });
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    let n = 0;
    labels.forEach((l) => {
      const hit = !q || l.dataset.text.includes(q);
      l.hidden = !hit;
      const span = l.querySelector("span");
      const raw = l.dataset.raw;
      if (hit && q) {
        const at = l.dataset.text.indexOf(q);
        span.innerHTML = esc(raw.slice(0, at)) + "<mark>" + esc(raw.slice(at, at + q.length)) +
          "</mark>" + esc(raw.slice(at + q.length));
      } else span.textContent = raw;
      if (hit) n++;
    });
    shown.textContent = q ? `符合 ${n} / ${labels.length} 項` : `共 ${labels.length} 項`;
    setActive(0);
  };
  toggle.addEventListener("click", () => {
    const open = box.classList.toggle("open");
    if (open) { search.value = ""; filter(); search.focus(); }
  });
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (e) => {
    const vis = visible();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (vis[active]) { const cb = vis[active].querySelector("input"); cb.checked = !cb.checked; refresh(); }
    } else if (e.key === "Escape") { e.preventDefault(); box.classList.remove("open"); }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) box.classList.remove("open"); });
  box.addEventListener("change", refresh);
  box.querySelector("[data-all]").addEventListener("click", () => {
    visible().forEach((l) => (l.querySelector("input").checked = true)); refresh();
  });
  box.querySelector("[data-none]").addEventListener("click", () => {
    labels.forEach((l) => (l.querySelector("input").checked = false)); refresh();
  });
  filter(); refresh();
}
const checkedLinks = (id) =>
  [...document.querySelectorAll(`#${id} [data-link]:checked`)].map((c) => c.value);

/* ==================================================== 儀表板 */
async function loadDashboard() {
  const day = document.getElementById("dash-date").value || todayStr();
  try {
    const d = await api(`/api/dashboard?target_date=${day}`);
    document.getElementById("stat-total").textContent = d.total_qc;
    document.getElementById("stat-pass").textContent = d.pass_count;
    document.getElementById("stat-warn").textContent = d.warning_count;
    document.getElementById("stat-fail").textContent = d.fail_count;
    document.getElementById("stat-westgard").textContent = d.westgard_violation_count;
    document.getElementById("stat-rate").textContent = d.pass_rate + "%";

    const vl = document.getElementById("violation-list");
    vl.innerHTML = d.violations.length ? d.violations.map((v) => `
      <div class="vrow">
        <div class="vhead">
          <span class="vtitle">${esc(v.instrument_name)} · ${esc(v.item_code)}/${esc(v.specimen_code)} (${esc(v.qc_level ?? "")})</span>
          <span class="badge ${esc(v.result_status)}">${esc(v.result_status)}</span>
        </div>
        <div class="vmeta">時間 ${esc(v.run_at ?? "-")} ｜ Z=${esc(v.z_score ?? "-")} ｜ 規則
          <span class="wg">${esc((v.westgard_flags || []).join(", "))}</span></div>
        ${v.note ? `<div class="vremark">${esc(v.note)}</div>` : ""}
      </div>`).join("") : `<div class="empty">✅ 本日無 Westgard 規則違規</div>`;

    const rb = document.getElementById("rule-bars");
    const rules = Object.entries(d.rule_counts);
    if (!rules.length) rb.innerHTML = `<div class="empty">無</div>`;
    else {
      const max = Math.max(...rules.map((r) => r[1]));
      rb.innerHTML = rules.map(([name, cnt]) => `
        <div class="bar-row"><span class="bar-label">${esc(name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(cnt / max) * 100}%"></span></span>
          <span class="bar-count">${cnt}</span></div>`).join("");
    }

    const il = document.getElementById("instrument-stats");
    const inst = Object.entries(d.by_instrument);
    il.innerHTML = inst.length ? inst.map(([name, s]) => `
      <div class="irow"><span>${esc(name)}</span>
        <span class="ipill ${s.fail ? "bad" : ""}">${s.total} 次 ／ 失敗 ${s.fail}</span></div>`).join("")
      : `<div class="empty">無資料</div>`;
  } catch (e) {
    document.getElementById("violation-list").innerHTML = `<div class="empty">載入失敗：${esc(e.message)}</div>`;
  }
}
document.getElementById("dash-refresh").addEventListener("click", loadDashboard);
document.getElementById("dash-date").addEventListener("change", loadDashboard);

/* ==================================================== 檢驗設定 (assay) */
let ASSAY_ROWS = [];

async function loadAssays() {
  const sn = document.getElementById("assay-instrument").value;
  const spec = document.getElementById("assay-specimen").value;
  const q = document.getElementById("assay-q").value.trim().toLowerCase();
  const inc = document.getElementById("assay-inactive").checked;
  if (!sn) {
    renderTable("assay-table", [{ key: "x", label: "" }], [], null, "請先選擇儀器");
    return;
  }
  const params = new URLSearchParams({ instrument_serial_number: sn });
  if (spec) params.set("specimen_code", spec);
  if (inc) params.set("include_inactive", "true");
  try {
    let rows = await api("/api/assays?" + params);
    if (q) rows = rows.filter((r) =>
      (r.item_code || "").toLowerCase().includes(q) || (r.item_name || "").toLowerCase().includes(q));
    ASSAY_ROWS = rows;
    renderTable("assay-table", [
      { key: "item_code", label: "項目代碼" },
      { key: "item_name", label: "項目全名", render: (r) => `<span class="muted-cell">${esc(r.item_name ?? "")}</span>` },
      { label: "檢體", render: (r) => `<span class="tag spec">${esc(r.specimen_code)}</span>` },
      { key: "result_unit", label: "單位" },
      { key: "method_name", label: "方法", render: (r) => esc(r.method_name ?? "-") },
      { label: "狀態", render: activePill },
    ], rows, (row) => [
      { label: "編輯", onClick: () => editAssay(row) },
      { label: "關聯", onClick: () => editAssayLinks(row) },
      { label: row.active ? "停用" : "啟用", onClick: () => toggleAssay(row) },
      { label: "刪除", cls: "danger", onClick: () => deleteAssay(row) },
    ], "此儀器尚無檢驗設定");
    setMsg("assay-msg", `共 ${rows.length} 筆`);
  } catch (e) {
    setMsg("assay-msg", "❌ " + e.message, "err");
  }
}

function editAssay(row) {
  Modal.open({
    title: `編輯檢驗設定：${row.item_code} / ${row.specimen_code}`,
    hint: "儀器、項目與檢體屬於 assay 的<strong>身分</strong>，不可修改。若要變更請停用此筆並另建新的，以免歷史結果失去意義。",
    fields: [
      { name: "result_unit", label: "結果單位", type: "text" },
      { name: "decimal_places", label: "小數位數", type: "number" },
      { name: "method_name", label: "方法名稱", type: "text" },
      { name: "instrument_test_code", label: "儀器端項目代碼", type: "text" },
      { name: "valid_from", label: "生效起日", type: "date" },
      { name: "valid_to", label: "生效迄日", type: "date" },
    ],
    values: row,
    onSave: async (v) => {
      await patch(`/api/assays/${row.assay_id}`, v);
      toast("已更新檢驗設定", "ok"); loadAssays();
    },
  });
}

async function editAssayLinks(row) {
  const [detail, rp, qp, cp] = await Promise.all([
    api(`/api/assays/${row.assay_id}`), api("/api/reagent-products"),
    api("/api/qc-products"), api("/api/calibrator-products"),
  ]);
  Modal.open({
    title: `設定關聯：${row.item_code} / ${row.specimen_code}`,
    hint: "整組覆寫。已被<strong>目標值或品管結果引用</strong>的關聯無法移除（會回報 409）。",
    fields: [
      { name: "reagents", label: "試劑產品", type: "multiselect",
        options: rp.map((p) => ({ value: p.reagent_product_id, label: p.product_name })),
        emptyText: "尚無試劑產品，請先於「產品與批號」建立" },
      { name: "qc", label: "品管液產品", type: "multiselect",
        options: qp.map((p) => ({ value: p.qc_product_id, label: p.product_name })),
        emptyText: "尚無品管液產品" },
      { name: "cal", label: "校正液產品", type: "multiselect",
        options: cp.map((p) => ({ value: p.calibrator_product_id, label: p.product_name })),
        emptyText: "尚無校正液產品" },
    ],
    values: {
      reagents: detail.reagents.map((x) => x.reagent_product_id),
      qc: detail.qc_products.map((x) => x.qc_product_id),
      cal: detail.calibrators.map((x) => x.calibrator_product_id),
    },
    onSave: async (v) => {
      await put(`/api/assays/${row.assay_id}/links`, {
        reagents: v.reagents.map((id) => ({ reagent_product_id: id, reagent_role: "PRIMARY" })),
        qc_product_ids: v.qc, calibrator_product_ids: v.cal,
      });
      toast("已更新關聯", "ok"); loadAssays();
    },
  });
}

async function toggleAssay(row) {
  try {
    await patch(`/api/assays/${row.assay_id}/active`, { active: !row.active });
    toast(`已${row.active ? "停用" : "啟用"} ${row.item_code}`, "ok");
    loadAssays();
  } catch (e) { toast("❌ " + e.message, "err"); }
}

async function deleteAssay(row) {
  if (!confirm(`確定刪除檢驗設定「${row.item_code} / ${row.specimen_code}」？\n若已有品管結果會被擋下，建議改用停用。`)) return;
  try {
    await del(`/api/assays/${row.assay_id}`);
    toast("已刪除", "ok"); loadAssays();
  } catch (e) { toast("❌ " + e.message, "err"); }
}

document.getElementById("assay-new").addEventListener("click", () => {
  const sn = document.getElementById("assay-instrument").value;
  if (!sn) return toast("請先選擇儀器", "err");
  Modal.open({
    title: "新增檢驗設定",
    hint: "同一儀器的同一<strong>項目 × 檢體</strong>只能有一筆；重複會被擋下。",
    fields: [
      { name: "item_code", label: "項目代碼*", type: "text", required: true, placeholder: "如 GLU" },
      { name: "specimen_code", label: "檢體別*", type: "select", required: true,
        options: SPECIMENS.map((s) => ({ value: s.specimen_code, label: `${s.specimen_code}（${s.specimen_name}）` })) },
      { name: "result_unit", label: "結果單位", type: "text" },
      { name: "method_name", label: "方法名稱", type: "text" },
      { name: "create_item_if_missing", label: "項目字典沒有時自動建立", type: "checkbox" },
      { name: "item_name", label: "項目全名（自動建立時用）", type: "text", full: true },
    ],
    values: { specimen_code: "B", create_item_if_missing: true },
    saveLabel: "建立",
    onSave: async (v) => {
      await post("/api/assays", { instrument_serial_number: sn, ...v });
      toast("已建立檢驗設定", "ok"); loadAssays();
    },
  });
});

document.getElementById("assay-batch").addEventListener("click", () => {
  const sn = document.getElementById("assay-instrument").value;
  if (!sn) return toast("請先選擇儀器", "err");
  Modal.open({
    title: "批次新增檢驗設定",
    hint: "一次為同一儀器、同一檢體建立多個項目。已存在者自動略過。",
    fields: [
      { name: "specimen_code", label: "檢體別*", type: "select", required: true,
        options: SPECIMENS.map((s) => ({ value: s.specimen_code, label: `${s.specimen_code}（${s.specimen_name}）` })) },
      { name: "items", label: "項目代碼（每行一個，或以逗號分隔）", type: "textarea" },
    ],
    values: { specimen_code: "B" },
    saveLabel: "批次建立",
    onSave: async (v) => {
      const list = (v.items || "").split(/[\n,、，]+/).map((s) => s.trim()).filter(Boolean);
      if (!list.length) throw new Error("請至少輸入一個項目代碼");
      const r = await post("/api/assays/batch", {
        instrument_serial_number: sn, specimen_code: v.specimen_code,
        create_item_if_missing: true, items: list,
      });
      toast(`已建立 ${r.created} 筆${r.skipped.length ? `，略過 ${r.skipped.length} 筆（已存在）` : ""}`, "ok");
      loadAssays();
    },
  });
});

document.getElementById("assay-copy").addEventListener("click", () => {
  const sn = document.getElementById("assay-instrument").value;
  if (!sn) return toast("請先選擇來源儀器", "err");
  const src = INSTRUMENTS.find((i) => i.serial_number === sn);
  // 預設目標＝以此台為主機的備機
  const backups = INSTRUMENTS.filter((i) => i.backup_of_serial === sn);
  Modal.open({
    title: `複製設定到備機（來源：${src ? src.instrument_name : sn}）`,
    hint: "複製 assay 與三種產品關聯。<strong>品管目標值預設不複製</strong>——備機一般需自行平測建立自己的 mean/SD。已存在的設定會略過，不會覆蓋。",
    fields: [
      { name: "target_serial_number", label: "目標儀器*", type: "select", required: true,
        options: INSTRUMENTS.filter((i) => i.serial_number !== sn)
          .map((i) => ({ value: i.serial_number, label: `${i.instrument_name}（${i.instrument_role}）· ${i.serial_number}` })) },
      { name: "include_reagents", label: "複製試劑關聯", type: "checkbox" },
      { name: "include_qc", label: "複製品管液關聯", type: "checkbox" },
      { name: "include_calibrators", label: "複製校正液關聯", type: "checkbox" },
      { name: "copy_qc_targets", label: "一併複製品管目標值（不建議）", type: "checkbox" },
    ],
    values: {
      target_serial_number: backups[0] ? backups[0].serial_number : "",
      include_reagents: true, include_qc: true, include_calibrators: true, copy_qc_targets: false,
    },
    saveLabel: "開始複製",
    onSave: async (v) => {
      const r = await post("/api/instruments/copy-to-backup", { source_serial_number: sn, ...v });
      const c = r.created;
      toast(`複製完成：assay ${c.assays}、試劑 ${c.reagents}、品管液 ${c.qc}、校正液 ${c.calibrators}`, "ok");
      loadAssays();
    },
  });
});

["assay-refresh"].forEach((id) => document.getElementById(id).addEventListener("click", loadAssays));
["assay-instrument", "assay-specimen", "assay-inactive"].forEach((id) =>
  document.getElementById(id).addEventListener("change", loadAssays));
document.getElementById("assay-q").addEventListener("keydown", (e) => { if (e.key === "Enter") loadAssays(); });
document.getElementById("assay-section").addEventListener("change", () => setTimeout(loadAssays, 0));

/* ==================================================== 品管目標值與平測 */
async function loadTargets() {
  const sn = document.getElementById("target-instrument").value;
  const hist = document.getElementById("target-history").checked;
  const p1 = new URLSearchParams(), p2 = new URLSearchParams();
  if (sn) { p1.set("instrument_serial_number", sn); p2.set("instrument_serial_number", sn); }
  if (hist) p1.set("include_history", "true");
  try {
    const [targets, pending] = await Promise.all([
      api("/api/qc-targets?" + p1), api("/api/qc-targets/pending-parallel-test?" + p2),
    ]);
    renderTable("pending-table", [
      { key: "serial_number", label: "儀器" },
      { label: "項目/檢體", render: (r) => `${esc(r.item_code)} <span class="tag spec">${esc(r.specimen_code)}</span>` },
      { key: "qc_product_name", label: "品管液" },
      { key: "level_code", label: "濃度" },
      { key: "lot_number", label: "批號" },
      { label: "原廠 Mean/SD", render: (r) => `${r.target_mean} / ${r.target_sd}` },
      { key: "expiry_date", label: "效期", render: (r) => esc(r.expiry_date ?? "-") },
    ], pending, (row) => [
      { label: "登錄平測", onClick: () => openParallelTest(row) },
    ], "✅ 沒有待平測項目");

    renderTable("target-table", [
      { key: "serial_number", label: "儀器" },
      { label: "項目/檢體", render: (r) => `${esc(r.item_code)} <span class="tag spec">${esc(r.specimen_code)}</span>` },
      { key: "qc_product_name", label: "品管液" },
      { key: "level_code", label: "濃度" },
      { key: "lot_number", label: "批號" },
      { label: "Mean / SD", render: (r) => `<b>${r.target_mean}</b> / ${r.target_sd}` },
      { label: "來源", render: (r) => r.target_source === "LAB"
          ? `<span class="tag lab">實驗室平測</span>` : `<span class="tag mfr">原廠值</span>` },
      { label: "生效", render: (r) => r.effective_to
          ? `<span class="muted-cell">${esc(String(r.effective_from).slice(0, 10))} ~ ${esc(String(r.effective_to).slice(0, 10))}</span>`
          : `<span class="state-pill on">生效中</span>` },
    ], targets, (row) => row.effective_to ? [] : [
      { label: "平測", onClick: () => openParallelTest(row) },
      { label: "編輯", onClick: () => editTarget(row) },
      { label: "刪除", cls: "danger", onClick: () => deleteTarget(row) },
    ], "尚無目標值");
    setMsg("target-msg", `目標值 ${targets.length} 筆｜待平測 ${pending.length} 筆`);
  } catch (e) {
    setMsg("target-msg", "❌ " + e.message, "err");
  }
}

function openParallelTest(row) {
  Modal.open({
    title: `登錄平測：${row.item_code} / ${row.specimen_code} · ${row.level_code}`,
    hint: `目前值：<strong>${row.target_mean} / ${row.target_sd}</strong>（${row.target_source === "LAB" ? "實驗室值" : "原廠值"}）。
           送出後舊版本會自動收效並保留，新建 <strong>LAB</strong> 版本；歷史判讀仍可重現。`,
    fields: [
      { name: "new_mean", label: "平測後新 Mean*", type: "number", required: true },
      { name: "new_sd", label: "平測後新 SD*", type: "number", required: true },
      { name: "acceptable_low", label: "可接受下限", type: "number" },
      { name: "acceptable_high", label: "可接受上限", type: "number" },
      { name: "effective_from", label: "生效時間", type: "datetime-local" },
      { name: "approved_by", label: "核可人", type: "text" },
      { name: "mark_lot_tested", label: "同時標記此批號為已平測", type: "checkbox" },
      { name: "note", label: "備註", type: "text", full: true },
    ],
    values: { mark_lot_tested: true, effective_from: nowLocal() },
    saveLabel: "登錄平測",
    onSave: async (v) => {
      const r = await post("/api/qc-targets/parallel-test", {
        assay_id: row.assay_id, qc_lot_id: row.qc_lot_id, ...v,
      });
      toast(`平測完成：${r.previous ? `${r.previous.mean}/${r.previous.sd} → ` : ""}${v.new_mean}/${v.new_sd}`, "ok");
      loadTargets();
    },
  });
}

function editTarget(row) {
  Modal.open({
    title: "編輯目標值",
    hint: "mean/SD 已被品管結果快照引用，屬判讀依據，<strong>不可直接修改</strong>——請改用「平測」建立新版本。此處僅能調整附註類欄位。",
    fields: [
      { name: "acceptable_low", label: "可接受下限", type: "number" },
      { name: "acceptable_high", label: "可接受上限", type: "number" },
      { name: "approved_by", label: "核可人", type: "text" },
      { name: "note", label: "備註", type: "text", full: true },
    ],
    values: row,
    onSave: async (v) => {
      await patch(`/api/qc-targets/${row.qc_target_id}`, v);
      toast("已更新", "ok"); loadTargets();
    },
  });
}

async function deleteTarget(row) {
  if (!confirm(`確定刪除此目標值？\n若已被品管結果引用會被擋下。`)) return;
  try { await del(`/api/qc-targets/${row.qc_target_id}`); toast("已刪除", "ok"); loadTargets(); }
  catch (e) { toast("❌ " + e.message, "err"); }
}

document.getElementById("target-new").addEventListener("click", async () => {
  const sn = document.getElementById("target-instrument").value;
  if (!sn) return toast("請先選擇儀器", "err");
  const [assays, lots] = await Promise.all([
    api(`/api/assays?instrument_serial_number=${encodeURIComponent(sn)}`),
    api(`/api/qc-lots?instrument_serial_number=${encodeURIComponent(sn)}`),
  ]);
  if (!lots.length) return toast("此儀器的檢驗設定尚未關聯任何品管液產品，請先於「檢驗設定 → 關聯」加入", "err");
  Modal.open({
    title: "建立品管目標值",
    hint: "目標值屬於 <strong>assay × 品管液批號</strong>。若該 assay 尚未關聯此品管液產品會被擋下。",
    fields: [
      { name: "assay_id", label: "檢驗設定*", type: "select", required: true,
        options: assays.map((a) => ({ value: a.assay_id, label: `${a.item_code} / ${a.specimen_code}` })) },
      { name: "qc_lot_id", label: "品管液批號*", type: "select", required: true,
        options: lots.map((l) => ({ value: l.qc_lot_id, label: `${l.product_name} · ${l.level_code} · ${l.lot_number}` })) },
      { name: "target_source", label: "來源*", type: "select", required: true,
        options: [{ value: "MANUFACTURER", label: "原廠值" }, { value: "LAB", label: "實驗室平測值" },
                  { value: "PEER_GROUP", label: "同儕組" }] },
      { name: "target_mean", label: "Mean*", type: "number", required: true },
      { name: "target_sd", label: "SD*（須 > 0）", type: "number", required: true },
      { name: "acceptable_low", label: "可接受下限", type: "number" },
      { name: "acceptable_high", label: "可接受上限", type: "number" },
      { name: "note", label: "備註", type: "text", full: true },
    ],
    values: { target_source: "MANUFACTURER" },
    saveLabel: "建立",
    onSave: async (v) => { await post("/api/qc-targets", v); toast("已建立目標值", "ok"); loadTargets(); },
  });
});

document.getElementById("target-refresh").addEventListener("click", loadTargets);
["target-instrument", "target-history"].forEach((id) =>
  document.getElementById(id).addEventListener("change", loadTargets));
document.getElementById("target-section").addEventListener("change", () => setTimeout(loadTargets, 0));

/* ==================================================== 登錄品管結果 */
let RUN_TARGETS = [];

async function loadRunLots() {
  const sn = document.getElementById("run-instrument").value;
  const sel = document.getElementById("run-lot");
  if (!sn) { sel.innerHTML = `<option value="">（請先選儀器）</option>`; return; }
  try {
    const lots = await api(`/api/qc-lots?instrument_serial_number=${encodeURIComponent(sn)}`);
    sel.innerHTML = lots.length
      ? lots.map((l) => `<option value="${esc(l.qc_lot_id)}">${esc(l.product_name)} · ${esc(l.level_code)} · ${esc(l.lot_number)}</option>`).join("")
      : `<option value="">（此儀器尚無可用品管液批號）</option>`;
  } catch { sel.innerHTML = `<option value="">（載入失敗）</option>`; }
  loadRunTargets();
}

async function loadRunTargets() {
  const sn = document.getElementById("run-instrument").value;
  const lotId = document.getElementById("run-lot").value;
  const box = document.getElementById("run-targets");
  document.getElementById("run-result").innerHTML = "";
  if (!sn || !lotId) { box.innerHTML = `<div class="empty">請選擇儀器與品管液批號</div>`; return; }
  try {
    const all = await api(`/api/qc-targets?instrument_serial_number=${encodeURIComponent(sn)}`);
    RUN_TARGETS = all.filter((t) => t.qc_lot_id === lotId);
    if (!RUN_TARGETS.length) {
      box.innerHTML = `<div class="empty">此批號在本儀器尚未建立任何目標值，請先至「品管目標值與平測」設定。</div>`;
      return;
    }
    box.innerHTML = `<div class="panel" style="padding:0;overflow:hidden">
      <div class="run-row run-head"><div>檢驗項目</div><div>目前 Mean / SD</div><div>量測值</div><div>單位</div></div>
      ${RUN_TARGETS.map((t, i) => `
        <div class="run-row">
          <div class="run-item">${esc(t.item_code)} <span class="tag spec">${esc(t.specimen_code)}</span>
            ${t.target_source === "LAB" ? `<span class="tag lab">LAB</span>` : `<span class="tag mfr">原廠</span>`}</div>
          <div class="muted-cell">${t.target_mean} / ${t.target_sd}</div>
          <div><input type="number" step="any" data-run="${i}" placeholder="留空＝不登錄" /></div>
          <div class="muted-cell">${esc(t.result_unit ?? "")}</div>
        </div>`).join("")}
    </div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">載入失敗：${esc(e.message)}</div>`;
  }
}

document.getElementById("run-submit").addEventListener("click", async () => {
  const sn = document.getElementById("run-instrument").value;
  const lotId = document.getElementById("run-lot").value;
  if (!sn || !lotId) return setMsg("run-msg", "❌ 請選擇儀器與品管液批號", "err");
  const results = [];
  document.querySelectorAll("#run-targets input[data-run]").forEach((el) => {
    const v = el.value.trim();
    if (v === "") return;
    results.push({ assay_id: RUN_TARGETS[Number(el.dataset.run)].assay_id, result_value: parseFloat(v) });
  });
  if (!results.length) return setMsg("run-msg", "❌ 請至少填入一個項目的量測值", "err");

  setMsg("run-msg", `送出中…（${results.length} 個項目）`);
  try {
    const at = document.getElementById("run-at").value;
    const r = await post("/api/qc-runs", {
      instrument_serial_number: sn, qc_lot_id: lotId,
      run_at: at ? at.replace("T", " ") + ":00" : null,
      operator_id: document.getElementById("run-operator").value.trim() || null,
      results,
    });
    const fail = r.results.filter((x) => x.result_status === "FAIL").length;
    const warn = r.results.filter((x) => x.result_status === "WARNING").length;
    setMsg("run-msg", `✅ 已登錄 ${r.results.length} 筆${fail ? `，FAIL ${fail}` : ""}${warn ? `，WARNING ${warn}` : ""}`, "ok");
    document.getElementById("run-result").innerHTML = `
      <div class="table-wrap" style="margin-top:14px"><table><thead><tr>
        <th>項目</th><th>檢體</th><th>結果</th><th>Mean/SD</th><th>Z-score</th><th>狀態</th><th>Westgard</th>
      </tr></thead><tbody>${r.results.map((x) => `<tr>
        <td>${esc(x.item_code)}</td><td>${esc(x.specimen_code)}</td>
        <td>${x.result_value}</td><td class="muted-cell">${x.target_mean_snapshot} / ${x.target_sd_snapshot}</td>
        <td>${x.z_score != null ? Number(x.z_score).toFixed(2) : "-"}</td>
        <td><span class="badge ${esc(x.result_status)}">${esc(x.result_status)}</span></td>
        <td class="wg">${esc((x.westgard_flags || []).join(", ") || "-")}</td></tr>`).join("")}</tbody></table></div>`;
    document.querySelectorAll("#run-targets input[data-run]").forEach((el) => (el.value = ""));
    loadDashboard();
  } catch (e) {
    setMsg("run-msg", "❌ " + e.message, "err");
  }
});
document.getElementById("run-instrument").addEventListener("change", loadRunLots);
document.getElementById("run-lot").addEventListener("change", loadRunTargets);
document.getElementById("run-section").addEventListener("change", () => setTimeout(loadRunLots, 0));

/* ==================================================== 品管紀錄查詢 */
async function loadResults() {
  const p = new URLSearchParams({ limit: "1000" });
  const g = (id) => document.getElementById(id).value;
  if (g("res-from")) p.set("date_from", g("res-from"));
  if (g("res-to")) p.set("date_to", g("res-to"));
  if (g("res-section")) p.set("section_name", g("res-section"));
  if (g("res-instrument")) p.set("instrument_serial_number", g("res-instrument"));
  if (g("res-item")) p.set("item_code", g("res-item").trim());
  if (g("res-status")) p.set("result_status", g("res-status"));
  try {
    const rows = await api("/api/qc-results?" + p);
    renderTable("res-table", [
      { key: "run_at", label: "時間", render: (r) => esc(String(r.run_at).replace("T", " ").slice(0, 19)) },
      { key: "instrument_name", label: "儀器" },
      { key: "item_code", label: "項目" },
      { label: "檢體", render: (r) => `<span class="tag spec">${esc(r.specimen_code)}</span>` },
      { key: "qc_level", label: "濃度" },
      { key: "qc_lot_number", label: "批號" },
      { key: "result_value", label: "結果" },
      { key: "unit_snapshot", label: "單位" },
      { label: "Mean/SD", render: (r) => `<span class="muted-cell">${r.target_mean_snapshot} / ${r.target_sd_snapshot}</span>` },
      { label: "Z", render: (r) => r.z_score != null ? Number(r.z_score).toFixed(2) : "-" },
      { label: "狀態", render: (r) => `<span class="badge ${esc(r.result_status)}">${esc(r.result_status)}</span>` },
      { label: "Westgard", cls: "wg", render: (r) => esc((r.westgard_flags || []).join(", ") || "-") },
    ], rows, null, "無符合條件的紀錄");
  } catch (e) { toast("❌ " + e.message, "err"); }
}
document.getElementById("res-refresh").addEventListener("click", loadResults);

/* ==================================================== L-J Chart */
let LJ_DATA = [];
window.__redrawLJ = () => { if (LJ_DATA.length) drawLJ(); };

async function loadLJItems() {
  const sn = document.getElementById("lj-instrument").value;
  const sel = document.getElementById("lj-item");
  if (!sn) { sel.innerHTML = ""; return; }
  const assays = await api(`/api/assays?instrument_serial_number=${encodeURIComponent(sn)}`);
  const codes = [...new Set(assays.map((a) => a.item_code))].sort();
  const prev = sel.value;
  sel.innerHTML = codes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (codes.includes(prev)) sel.value = prev;
}

async function loadLJ() {
  const sn = document.getElementById("lj-instrument").value;
  const item = document.getElementById("lj-item").value;
  const box = document.getElementById("lj-charts");
  if (!sn || !item) { box.innerHTML = `<div class="empty">請選擇儀器與檢驗項目</div>`; return; }
  const p = new URLSearchParams({ instrument_serial_number: sn, item_code: item });
  const f = document.getElementById("lj-from").value, t = document.getElementById("lj-to").value;
  if (f) p.set("date_from", f);
  if (t) p.set("date_to", t);
  try {
    LJ_DATA = await api("/api/qc-results/lj?" + p);
    drawLJ();
  } catch (e) { box.innerHTML = `<div class="empty">載入失敗：${esc(e.message)}</div>`; }
}

function drawLJ() {
  const box = document.getElementById("lj-charts");
  if (!LJ_DATA.length) { box.innerHTML = `<div class="empty">此條件下無資料</div>`; return; }
  box.innerHTML = "";
  const css = getComputedStyle(document.documentElement);
  const chartBg = css.getPropertyValue("--chart-bg").trim();
  const border = css.getPropertyValue("--border").trim();
  const stroke = css.getPropertyValue("--chart-point-stroke").trim();
  const muted = css.getPropertyValue("--muted").trim();

  LJ_DATA.forEach((s) => {
    const mean = Number(s.mean), sd = Number(s.sd);
    if (!sd) return;
    const W = 900, H = 320, m = { top: 20, right: 96, bottom: 40, left: 56 };
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const yMax = mean + 4 * sd, yMin = mean - 4 * sd;
    const yPx = (v) => m.top + ((yMax - v) / (yMax - yMin)) * ph;
    const n = s.points.length;
    const xPx = (i) => (n === 1 ? m.left + pw / 2 : m.left + (i / (n - 1)) * pw);
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, at, txt) => {
      const e = document.createElementNS(NS, tag);
      for (const k in at) e.setAttribute(k, at[k]);
      if (txt != null) e.textContent = txt;
      return e;
    };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    svg.appendChild(el("rect", { x: m.left, y: m.top, width: pw, height: ph, fill: chartBg, stroke: border }));
    [[3, "#ef4444", "+3SD"], [2, "#f59e0b", "+2SD"], [1, "#7c8aa0", "+1SD"], [0, "#22c55e", "Mean"],
     [-1, "#7c8aa0", "-1SD"], [-2, "#f59e0b", "-2SD"], [-3, "#ef4444", "-3SD"]].forEach(([k, color, label]) => {
      const v = mean + k * sd, y = yPx(v);
      svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + pw, y2: y, stroke: color,
        "stroke-width": k === 0 ? 1.6 : 1, "stroke-dasharray": k === 0 ? "" : "5 4", opacity: k === 0 ? .95 : .7 }));
      svg.appendChild(el("text", { x: m.left + pw + 8, y: y + 4, fill: color, "font-size": 11 },
        `${label} ${v.toFixed(2)}`));
    });
    if (n > 1) {
      const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${xPx(i).toFixed(1)},${yPx(p.value).toFixed(1)}`).join(" ");
      svg.appendChild(el("path", { d, fill: "none", stroke: "#38bdf8", "stroke-width": 1.4, opacity: .85 }));
    }
    const color = { PASS: "#22c55e", WARNING: "#f59e0b", FAIL: "#ef4444" };
    s.points.forEach((p, i) => {
      const cx = xPx(i), cy = yPx(p.value);
      const c = el("circle", { cx, cy, r: 4.5, fill: color[p.status] || "#38bdf8", stroke, "stroke-width": 1 });
      c.appendChild(el("title", {}, `${String(p.run_at).replace("T", " ").slice(0, 19)}\n值 ${p.value} ${s.unit || ""}\nZ=${p.z != null ? Number(p.z).toFixed(2) : "-"} ｜ ${p.status}${(p.westgard || []).length ? "\n" + p.westgard.join(", ") : ""}`));
      svg.appendChild(c);
      const step = Math.max(1, Math.ceil(n / 9));
      if (i % step === 0 || i === n - 1)
        svg.appendChild(el("text", { x: cx, y: H - m.bottom + 18, fill: muted, "font-size": 10, "text-anchor": "middle" },
          String(p.run_at).slice(5, 10)));
    });
    const card = document.createElement("div");
    card.className = "lj-chart";
    card.innerHTML = `<h3>${esc(s.label)}</h3>
      <div class="lj-sub">Mean ${s.mean} ${esc(s.unit || "")} ｜ SD ${s.sd} ｜ 共 ${n} 點</div>`;
    card.appendChild(svg);
    box.appendChild(card);
  });
}
document.getElementById("lj-refresh").addEventListener("click", loadLJ);
document.getElementById("lj-instrument").addEventListener("change", async () => { await loadLJItems(); loadLJ(); });
document.getElementById("lj-item").addEventListener("change", loadLJ);
document.getElementById("lj-section").addEventListener("change", () => setTimeout(async () => { await loadLJItems(); loadLJ(); }, 0));

/* ==================================================== 校正紀錄 */
async function loadCalibrations() {
  const p = new URLSearchParams();
  const g = (id) => document.getElementById(id).value;
  if (g("cal-instrument")) p.set("instrument_serial_number", g("cal-instrument"));
  if (g("cal-from")) p.set("date_from", g("cal-from"));
  if (g("cal-to")) p.set("date_to", g("cal-to"));
  const box = document.getElementById("cal-list");
  try {
    const rows = await api("/api/calibration-events?" + p);
    box.innerHTML = rows.length ? rows.map((r) => `
      <div class="cal-card ${r.event_status === "PASS" ? "pass" : r.event_status === "FAIL" ? "fail" : ""}">
        <div class="cal-head">
          <span class="cal-title">${esc(r.instrument_name)}（${esc(r.serial_number)}）</span>
          <span class="badge ${r.event_status === "PASS" ? "Pass" : "Fail"}">${esc(r.event_status)}</span>
          <span class="tag">${esc(r.calibration_reason)}</span>
        </div>
        <div class="cal-meta">${esc(String(r.performed_at).replace("T", " ").slice(0, 19))}
          ｜校正液 ${esc(r.calibrator_product_name)} · 批號 ${esc(r.calibrator_lot_number)}
          ${r.operator_id ? `｜操作者 ${esc(r.operator_id)}` : ""}</div>
        <div class="cal-assays">${r.assays.map((a) =>
          `<span class="tag ${a.assay_status === "PASS" ? "lab" : "mfr"}">${esc(a.item_code)}/${esc(a.specimen_code)} ${esc(a.assay_status)}</span>`).join("")}</div>
        ${r.note ? `<div class="cal-meta">${esc(r.note)}</div>` : ""}
      </div>`).join("") : `<div class="empty">無校正紀錄</div>`;
  } catch (e) { box.innerHTML = `<div class="empty">載入失敗：${esc(e.message)}</div>`; }
}

document.getElementById("cal-new").addEventListener("click", async () => {
  const sn = document.getElementById("cal-instrument").value;
  if (!sn) return toast("請先選擇儀器", "err");
  const [assays, prods] = await Promise.all([
    api(`/api/assays?instrument_serial_number=${encodeURIComponent(sn)}`),
    api("/api/calibrator-products"),
  ]);
  const lots = prods.flatMap((p) => (p.lots || []).map((l) =>
    ({ value: l.calibrator_lot_id, label: `${p.product_name} · ${l.level_code} · ${l.lot_number}` })));
  if (!lots.length) return toast("尚無校正液批號，請先於「產品與批號」建立", "err");
  Modal.open({
    title: "登錄校正事件",
    hint: "一次校正可涵蓋多個檢驗設定；所選項目必須屬於此儀器，且已關聯該校正液產品。",
    fields: [
      { name: "calibrator_lot_id", label: "校正液批號*", type: "select", required: true, options: lots },
      { name: "performed_at", label: "校正時間", type: "datetime-local" },
      { name: "calibration_reason", label: "原因*", type: "select", required: true,
        options: ["SCHEDULED", "NEW_LOT", "QC_FAILURE", "MAINTENANCE", "OTHER"].map((v) => ({ value: v, label: v })) },
      { name: "event_status", label: "結果*", type: "select", required: true,
        options: ["PASS", "FAIL", "CANCELLED"].map((v) => ({ value: v, label: v })) },
      { name: "operator_id", label: "操作者", type: "text" },
      { name: "assay_ids", label: "涵蓋的檢驗設定", type: "multiselect",
        options: assays.map((a) => ({ value: a.assay_id, label: `${a.item_code} / ${a.specimen_code}` })) },
      { name: "note", label: "備註", type: "text", full: true },
    ],
    values: { performed_at: nowLocal(), calibration_reason: "SCHEDULED", event_status: "PASS" },
    saveLabel: "登錄",
    onSave: async (v) => {
      await post("/api/calibration-events", {
        instrument_serial_number: sn, calibrator_lot_id: v.calibrator_lot_id,
        performed_at: v.performed_at ? v.performed_at.replace("T", " ") + ":00" : null,
        operator_id: v.operator_id, calibration_reason: v.calibration_reason,
        event_status: v.event_status, note: v.note,
        assays: (v.assay_ids || []).map((id) => ({ assay_id: id, assay_status: v.event_status })),
      });
      toast("已登錄校正事件", "ok"); loadCalibrations();
    },
  });
});
document.getElementById("cal-refresh").addEventListener("click", loadCalibrations);

/* ==================================================== 產品與批號 */
let PROD_TYPE = "reagent";
const PROD_CONF = {
  reagent: { path: "/api/reagent-products", lotPath: "/api/reagent-lots", pk: "reagent_product_id",
             lotPk: "reagent_lot_id", label: "試劑", res: "reagent-products", lotRes: "reagent-lots" },
  qc: { path: "/api/qc-products", lotPath: "/api/qc-lots", pk: "qc_product_id",
        lotPk: "qc_lot_id", label: "品管液", res: "qc-products", lotRes: "qc-lots", hasLevel: true },
  calibrator: { path: "/api/calibrator-products", lotPath: "/api/calibrator-lots", pk: "calibrator_product_id",
                lotPk: "calibrator_lot_id", label: "校正液", res: "calibrator-products", lotRes: "calibrator-lots", hasLevel: true },
};

document.querySelectorAll(".mode-tab[data-ptype]").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".mode-tab[data-ptype]").forEach((t) => t.classList.toggle("active", t === tab));
    PROD_TYPE = tab.dataset.ptype;
    loadProducts();
  }));

async function loadProducts() {
  const c = PROD_CONF[PROD_TYPE];
  const inc = document.getElementById("prod-inactive").checked;
  const box = document.getElementById("prod-list");
  try {
    const rows = await api(`${c.path}${inc ? "?include_inactive=true" : ""}`);
    box.innerHTML = rows.length ? rows.map((p) => `
      <div class="prod-card" data-pid="${esc(p[c.pk])}">
        <div class="prod-head">
          <h4>${esc(p.product_name)}</h4>
          <span class="prod-meta">${esc(p.product_code)}${p.manufacturer ? " ｜ " + esc(p.manufacturer) : ""}</span>
          ${activePill(p)}
          <div class="head-actions">
            <button class="btn-xs" data-act="edit">編輯</button>
            <button class="btn-xs" data-act="addlot">新增批號</button>
            <button class="btn-xs" data-act="toggle">${p.active ? "停用" : "啟用"}</button>
            <button class="btn-xs danger" data-act="del">刪除</button>
          </div>
        </div>
        ${(p.lots || []).length ? p.lots.map((l) => `
          <div class="lot-row" data-lid="${esc(l[c.lotPk])}">
            <span class="lot-no">${esc(l.lot_number)}</span>
            ${c.hasLevel ? `<span class="tag">${esc(l.level_code)}</span>` : ""}
            <span class="muted-cell">效期 ${esc(l.expiry_date ?? "-")}</span>
            <span class="state-pill ${l.lot_status === "IN_USE" || l.lot_status === "AVAILABLE" ? "on" : "off"}">${esc(l.lot_status)}</span>
            ${"parallel_test_done" in l ? pill(l.parallel_test_done, "已平測", "未平測") : ""}
            <div class="row-actions">
              <button class="btn-xs" data-lot="edit">編輯</button>
              <button class="btn-xs" data-lot="status">狀態</button>
              <button class="btn-xs danger" data-lot="del">刪除</button>
            </div>
          </div>`).join("") : `<div class="lot-empty">尚無批號</div>`}
      </div>`).join("") : `<div class="empty">尚無${c.label}產品</div>`;

    box.querySelectorAll(".prod-card").forEach((card) => {
      const p = rows.find((x) => x[c.pk] === card.dataset.pid);
      card.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.act === "edit") editProduct(p);
        if (b.dataset.act === "addlot") addLot(p);
        if (b.dataset.act === "toggle") toggleProduct(p);
        if (b.dataset.act === "del") deleteProduct(p);
      }));
      card.querySelectorAll(".lot-row").forEach((lr) => {
        const l = (p.lots || []).find((x) => x[c.lotPk] === lr.dataset.lid);
        lr.querySelectorAll("[data-lot]").forEach((b) => b.addEventListener("click", () => {
          if (b.dataset.lot === "edit") editLot(p, l);
          if (b.dataset.lot === "status") changeLotStatus(l);
          if (b.dataset.lot === "del") deleteLot(l);
        }));
      });
    });
    setMsg("prod-msg", `共 ${rows.length} 個${c.label}產品`);
  } catch (e) { setMsg("prod-msg", "❌ " + e.message, "err"); }
}

const productFields = (hasMatrix) => [
  { name: "product_code", label: "產品代碼*", type: "text", required: true },
  { name: "product_name", label: "產品名稱*", type: "text", required: true },
  { name: "manufacturer", label: "廠商", type: "text" },
  { name: "catalog_number", label: "型錄編號", type: "text" },
  ...(hasMatrix ? [{ name: "matrix_description", label: "基質說明", type: "text" }] : []),
  { name: "storage_condition", label: "保存條件", type: "text", full: true },
];

document.getElementById("prod-new").addEventListener("click", () => {
  const c = PROD_CONF[PROD_TYPE];
  Modal.open({
    title: `新增${c.label}產品`,
    hint: "產品是<strong>穩定定義</strong>，不含批號。換批號請在產品下新增 lot。",
    fields: productFields(PROD_TYPE !== "reagent"),
    saveLabel: "建立",
    onSave: async (v) => { await post(c.path, v); toast("已建立產品", "ok"); loadProducts(); },
  });
});

function editProduct(p) {
  const c = PROD_CONF[PROD_TYPE];
  Modal.open({
    title: `編輯${c.label}產品`,
    fields: productFields(PROD_TYPE !== "reagent"),
    values: p,
    onSave: async (v) => { await patch(`/api/${c.res}/${p[c.pk]}`, v); toast("已更新", "ok"); loadProducts(); },
  });
}

async function toggleProduct(p) {
  const c = PROD_CONF[PROD_TYPE];
  try {
    await patch(`/api/${c.res}/${p[c.pk]}/active`, { active: !p.active });
    toast(`已${p.active ? "停用" : "啟用"}`, "ok"); loadProducts();
  } catch (e) { toast("❌ " + e.message, "err"); }
}

async function deleteProduct(p) {
  const c = PROD_CONF[PROD_TYPE];
  if (!confirm(`確定刪除產品「${p.product_name}」？\n若已被 assay 關聯或有批號會被擋下，建議改用停用。`)) return;
  try { await del(`/api/${c.res}/${p[c.pk]}`); toast("已刪除", "ok"); loadProducts(); }
  catch (e) { toast("❌ " + e.message, "err"); }
}

const LOT_STATUSES = ["QUARANTINE", "AVAILABLE", "IN_USE", "EXHAUSTED", "EXPIRED", "RECALLED"];

function lotFields(type) {
  const c = PROD_CONF[type];
  return [
    { name: "lot_number", label: "批號*", type: "text", required: true },
    ...(c.hasLevel ? [{ name: "level_code", label: "濃度 / Level*", type: "text", required: true,
                        placeholder: type === "qc" ? "如 Level 1" : "DEFAULT" }] : []),
    { name: "received_at", label: "入庫日", type: "date" },
    { name: "expiry_date", label: "效期", type: "date" },
    { name: "lot_status", label: "狀態*", type: "select", required: true,
      options: LOT_STATUSES.map((s) => ({ value: s, label: s })) },
    ...(type !== "calibrator" ? [
      { name: "parallel_test_done", label: "已完成平測", type: "checkbox" },
      { name: "parallel_test_date", label: "平測完成日", type: "date" },
    ] : []),
    ...(type === "reagent" ? [
      { name: "same_lot_as_previous", label: "與上一批同批號", type: "checkbox" },
    ] : []),
    ...(type === "calibrator" ? [
      { name: "assigned_value_text", label: "原廠指定值", type: "text", full: true },
    ] : []),
    { name: "note", label: "備註", type: "text", full: true },
  ];
}

function addLot(p) {
  const c = PROD_CONF[PROD_TYPE];
  Modal.open({
    title: `新增批號：${p.product_name}`,
    hint: "換批號只需新增 lot，<strong>assay 的關聯不受影響</strong>。",
    fields: lotFields(PROD_TYPE),
    values: { lot_status: "AVAILABLE", level_code: PROD_TYPE === "calibrator" ? "DEFAULT" : "" },
    saveLabel: "建立",
    onSave: async (v) => {
      await post(c.lotPath, { [c.pk]: p[c.pk], ...v });
      toast("已新增批號", "ok"); loadProducts();
    },
  });
}

function editLot(p, l) {
  const c = PROD_CONF[PROD_TYPE];
  Modal.open({
    title: `編輯批號：${l.lot_number}`,
    fields: lotFields(PROD_TYPE),
    values: l,
    onSave: async (v) => { await patch(`/api/${c.lotRes}/${l[c.lotPk]}`, v); toast("已更新", "ok"); loadProducts(); },
  });
}

function changeLotStatus(l) {
  const c = PROD_CONF[PROD_TYPE];
  Modal.open({
    title: `變更批號狀態：${l.lot_number}`,
    fields: [{ name: "lot_status", label: "狀態*", type: "select", required: true,
               options: LOT_STATUSES.map((s) => ({ value: s, label: s })) }],
    values: l,
    onSave: async (v) => {
      await patch(`/api/${c.lotRes}/${l[c.lotPk]}/status`, v);
      toast("已變更狀態", "ok"); loadProducts();
    },
  });
}

async function deleteLot(l) {
  const c = PROD_CONF[PROD_TYPE];
  if (!confirm(`確定刪除批號「${l.lot_number}」？\n若已被目標值或品管結果引用會被擋下。`)) return;
  try { await del(`/api/${c.lotRes}/${l[c.lotPk]}`); toast("已刪除", "ok"); loadProducts(); }
  catch (e) { toast("❌ " + e.message, "err"); }
}

document.getElementById("lot-new").addEventListener("click", async () => {
  const c = PROD_CONF[PROD_TYPE];
  const prods = await api(c.path);
  if (!prods.length) return toast(`請先建立${c.label}產品`, "err");
  Modal.open({
    title: `新增${c.label}批號`,
    fields: [
      { name: "__pid", label: "產品*", type: "select", required: true,
        options: prods.map((p) => ({ value: p[c.pk], label: p.product_name })) },
      ...lotFields(PROD_TYPE),
    ],
    values: { lot_status: "AVAILABLE", level_code: PROD_TYPE === "calibrator" ? "DEFAULT" : "" },
    saveLabel: "建立",
    onSave: async (v) => {
      const { __pid, ...rest } = v;
      await post(c.lotPath, { [c.pk]: __pid, ...rest });
      toast("已新增批號", "ok"); loadProducts();
    },
  });
});
document.getElementById("prod-refresh").addEventListener("click", loadProducts);
document.getElementById("prod-inactive").addEventListener("change", loadProducts);

/* ==================================================== 試劑上機 */
async function loadLoads() {
  const p = new URLSearchParams();
  const sn = document.getElementById("load-instrument").value;
  if (sn) p.set("instrument_serial_number", sn);
  p.set("current_only", document.getElementById("load-current").checked ? "true" : "false");
  try {
    const rows = await api("/api/reagent-loads?" + p);
    renderTable("load-table", [
      { key: "instrument_name", label: "儀器" },
      { key: "position_code", label: "位置" },
      { key: "product_name", label: "試劑產品" },
      { key: "lot_number", label: "批號" },
      { key: "expiry_date", label: "效期", render: (r) => esc(r.expiry_date ?? "-") },
      { label: "上機時間", render: (r) => esc(String(r.loaded_at).replace("T", " ").slice(0, 19)) },
      { label: "狀態", render: (r) => r.unloaded_at
          ? `<span class="state-pill off">已下機 ${esc(String(r.unloaded_at).slice(0, 10))}</span>`
          : `<span class="state-pill on">在線上</span>` },
    ], rows, (row) => row.unloaded_at ? [] : [
      { label: "下機", onClick: async () => {
        try { await patch(`/api/reagent-loads/${row.reagent_load_id}/unload`, {}); toast("已下機", "ok"); loadLoads(); }
        catch (e) { toast("❌ " + e.message, "err"); }
      } },
    ], "無上機紀錄");
    setMsg("load-msg", `共 ${rows.length} 筆`);
  } catch (e) { setMsg("load-msg", "❌ " + e.message, "err"); }
}

document.getElementById("load-new").addEventListener("click", async () => {
  const sn = document.getElementById("load-instrument").value;
  if (!sn) return toast("請先選擇儀器", "err");
  const prods = await api("/api/reagent-products");
  const lots = prods.flatMap((p) => (p.lots || []).map((l) =>
    ({ value: l.reagent_lot_id, label: `${p.product_name} · ${l.lot_number}（${l.lot_status}）` })));
  if (!lots.length) return toast("尚無試劑批號", "err");
  Modal.open({
    title: "試劑上機",
    hint: "同一台儀器的<strong>同一位置</strong>同時只能有一批試劑在線上。",
    fields: [
      { name: "reagent_lot_id", label: "試劑批號*", type: "select", required: true, options: lots },
      { name: "position_code", label: "位置代碼*", type: "text", required: true, placeholder: "如 R1" },
      { name: "loaded_at", label: "上機時間", type: "datetime-local" },
      { name: "loaded_by", label: "操作者", type: "text" },
      { name: "note", label: "備註", type: "text", full: true },
    ],
    values: { loaded_at: nowLocal() },
    saveLabel: "上機",
    onSave: async (v) => {
      await post("/api/reagent-loads", {
        instrument_serial_number: sn, ...v,
        loaded_at: v.loaded_at ? v.loaded_at.replace("T", " ") + ":00" : null,
      });
      toast("已上機", "ok"); loadLoads();
    },
  });
});
document.getElementById("load-refresh").addEventListener("click", loadLoads);
document.getElementById("load-current").addEventListener("change", loadLoads);

/* ==================================================== 基礎主檔 CRUD */
async function loadInstrumentsPage() {
  const inc = document.getElementById("inst-inactive").checked;
  const d = await api(`/api/instruments${inc ? "?include_inactive=true" : ""}`);
  renderTable("inst-table", [
    { key: "serial_number", label: "序號" },
    { key: "instrument_name", label: "名稱" },
    { key: "section_name", label: "組別" },
    { key: "model_name", label: "機型", render: (r) => esc(r.model_name ?? "-") },
    { label: "角色", render: (r) => `<span class="tag">${esc(r.instrument_role)}</span>` },
    { label: "對應主機", render: (r) => r.backup_of_serial
        ? `<span class="muted-cell">${esc(r.backup_of_name)}（${esc(r.backup_of_serial)}）</span>` : "-" },
    { label: "狀態", render: activePill },
  ], d.all, (row) => [
    { label: "編輯", onClick: () => editInstrument(row) },
    { label: row.active ? "停用" : "啟用", onClick: async () => {
      try { await patch(`/api/instruments/${row.instrument_id}/active`, { active: !row.active });
        toast("已更新", "ok"); await loadMasters(); loadInstrumentsPage(); }
      catch (e) { toast("❌ " + e.message, "err"); } } },
    { label: "刪除", cls: "danger", onClick: async () => {
      if (!confirm(`確定刪除儀器「${row.instrument_name}」？\n若已有檢驗設定會被擋下。`)) return;
      try { await del(`/api/instruments/${row.instrument_id}`); toast("已刪除", "ok");
        await loadMasters(); loadInstrumentsPage(); }
      catch (e) { toast("❌ " + e.message, "err"); } } },
  ]);
  setMsg("inst-msg", `共 ${d.all.length} 台`);
}

const instFields = () => [
  { name: "serial_number", label: "序號*", type: "text", required: true },
  { name: "instrument_name", label: "名稱*", type: "text", required: true },
  { name: "section_name", label: "組別*", type: "select", required: true,
    options: SECTIONS.map((s) => ({ value: s.section_name, label: s.section_name })) },
  { name: "model_name", label: "機型", type: "text", placeholder: "如 XN-3000" },
  { name: "instrument_role", label: "角色*", type: "select", required: true,
    options: ["主機", "備機", "其他"].map((v) => ({ value: v, label: v })) },
  { name: "backup_of_serial_number", label: "對應主機（備機才需填）", type: "select", allowEmpty: true,
    options: INSTRUMENTS.filter((i) => i.instrument_role === "主機")
      .map((i) => ({ value: i.serial_number, label: `${i.instrument_name}（${i.serial_number}）` })) },
  { name: "manufacturer", label: "廠商", type: "text" },
  { name: "installed_at", label: "安裝日", type: "date" },
];

document.getElementById("inst-new").addEventListener("click", () => Modal.open({
  title: "新增儀器",
  hint: "備機請選「對應主機」，之後才能使用<strong>複製設定到備機</strong>功能。",
  fields: instFields(), values: { instrument_role: "主機" }, saveLabel: "建立",
  onSave: async (v) => { await post("/api/instruments", v); toast("已建立", "ok");
    await loadMasters(); loadInstrumentsPage(); },
}));

function editInstrument(row) {
  Modal.open({
    title: `編輯儀器：${row.instrument_name}`,
    fields: instFields().filter((f) => f.name !== "section_name").concat([
      { name: "retired_at", label: "除役日", type: "date" },
    ]),
    values: { ...row, backup_of_serial_number: row.backup_of_serial || "" },
    onSave: async (v) => {
      await patch(`/api/instruments/${row.instrument_id}`, v);
      toast("已更新", "ok"); await loadMasters(); loadInstrumentsPage();
    },
  });
}

async function loadTestItems() {
  const q = document.getElementById("item-q").value.trim();
  const rows = await api("/api/test-items" + (q ? `?q=${encodeURIComponent(q)}` : ""));
  renderTable("item-table", [
    { key: "item_code", label: "代碼" },
    { key: "item_name", label: "全名", render: (r) => esc(r.item_name ?? "-") },
    { key: "default_unit", label: "預設單位", render: (r) => esc(r.default_unit ?? "-") },
    { key: "loinc_code", label: "LOINC", render: (r) => esc(r.loinc_code ?? "-") },
    { label: "狀態", render: activePill },
  ], rows, (row) => [
    { label: "編輯", onClick: () => Modal.open({
      title: `編輯項目：${row.item_code}`,
      fields: [
        { name: "item_code", label: "代碼*", type: "text", required: true },
        { name: "item_name", label: "全名", type: "text" },
        { name: "default_unit", label: "預設單位", type: "text" },
        { name: "loinc_code", label: "LOINC", type: "text" },
      ], values: row,
      onSave: async (v) => { await patch(`/api/test-items/${row.test_item_id}`, v); toast("已更新", "ok"); loadTestItems(); },
    }) },
    { label: "刪除", cls: "danger", onClick: async () => {
      if (!confirm(`確定刪除項目「${row.item_code}」？\n若已被檢驗設定使用會被擋下。`)) return;
      try { await del(`/api/test-items/${row.test_item_id}`); toast("已刪除", "ok"); loadTestItems(); }
      catch (e) { toast("❌ " + e.message, "err"); } } },
  ]);
  setMsg("item-msg", `共 ${rows.length} 項`);
}

document.getElementById("item-new").addEventListener("click", () => Modal.open({
  title: "新增檢驗項目",
  hint: "全院共用字典。同一項目在不同儀器 / 檢體上只需建立<strong>一次</strong>。",
  fields: [
    { name: "item_code", label: "代碼*", type: "text", required: true, placeholder: "如 GLU" },
    { name: "item_name", label: "全名", type: "text" },
    { name: "default_unit", label: "預設單位", type: "text" },
    { name: "loinc_code", label: "LOINC", type: "text" },
  ], saveLabel: "建立",
  onSave: async (v) => { await post("/api/test-items", v); toast("已建立", "ok"); loadTestItems(); },
}));
document.getElementById("item-refresh").addEventListener("click", loadTestItems);
document.getElementById("item-q").addEventListener("keydown", (e) => { if (e.key === "Enter") loadTestItems(); });

async function loadSpecimens() {
  const rows = await api("/api/specimen-types");
  renderTable("spec-table", [
    { key: "specimen_code", label: "代碼" },
    { key: "specimen_name", label: "名稱" },
    { key: "description", label: "說明", render: (r) => esc(r.description ?? "-") },
    { label: "狀態", render: activePill },
  ], rows, (row) => [
    { label: "編輯", onClick: () => Modal.open({
      title: `編輯檢體類別：${row.specimen_code}`,
      fields: [
        { name: "specimen_code", label: "代碼*", type: "text", required: true },
        { name: "specimen_name", label: "名稱*", type: "text", required: true },
        { name: "description", label: "說明", type: "text", full: true },
      ], values: row,
      onSave: async (v) => { await patch(`/api/specimen-types/${row.specimen_type_id}`, v);
        toast("已更新", "ok"); await loadMasters(); loadSpecimens(); },
    }) },
  ]);
}
document.getElementById("spec-new").addEventListener("click", () => Modal.open({
  title: "新增檢體類別",
  fields: [
    { name: "specimen_code", label: "代碼*", type: "text", required: true, placeholder: "如 B / U / CSF" },
    { name: "specimen_name", label: "名稱*", type: "text", required: true, placeholder: "如 BLOOD" },
    { name: "description", label: "說明", type: "text", full: true },
  ], saveLabel: "建立",
  onSave: async (v) => { await post("/api/specimen-types", v); toast("已建立", "ok");
    await loadMasters(); loadSpecimens(); },
}));

async function loadSections() {
  const rows = await api("/api/sections");
  renderTable("sec-table", [
    { key: "section_code", label: "代碼" },
    { key: "section_name", label: "名稱" },
    { key: "description", label: "說明", render: (r) => esc(r.description ?? "-") },
    { label: "狀態", render: activePill },
  ], rows, (row) => [
    { label: "編輯", onClick: () => Modal.open({
      title: `編輯組別：${row.section_name}`,
      fields: [
        { name: "section_code", label: "代碼*", type: "text", required: true },
        { name: "section_name", label: "名稱*", type: "text", required: true },
        { name: "description", label: "說明", type: "text", full: true },
      ], values: row,
      onSave: async (v) => { await patch(`/api/sections/${row.section_id}`, v);
        toast("已更新", "ok"); await loadMasters(); loadSections(); },
    }) },
  ]);
}
document.getElementById("sec-new").addEventListener("click", () => Modal.open({
  title: "新增組別",
  fields: [
    { name: "section_code", label: "代碼*", type: "text", required: true },
    { name: "section_name", label: "名稱*", type: "text", required: true },
    { name: "description", label: "說明", type: "text", full: true },
  ], saveLabel: "建立",
  onSave: async (v) => { await post("/api/sections", v); toast("已建立", "ok");
    await loadMasters(); loadSections(); },
}));

/* ==================================================== 主檔關聯圖 */
let ER = null, erSelected = null;
window.__redrawER = () => { if (ER) drawEREdges(); };

async function loadER() {
  const sn = document.getElementById("er-instrument").value;
  const cols = document.getElementById("er-columns");
  if (!sn) { cols.innerHTML = `<div class="er-empty">請先選擇儀器</div>`; return; }
  try { ER = await api(`/api/er-graph?instrument_serial_number=${encodeURIComponent(sn)}`); }
  catch (e) { cols.innerHTML = `<div class="er-empty">載入失敗：${esc(e.message)}</div>`; return; }

  const c = ER.counts;
  document.getElementById("er-stats").innerHTML = [
    `品管液 ${c.qc_products}`, `試劑 ${c.reagents}`, `檢驗設定 ${c.assays}`,
    `試劑↔設定 ${c.reagent_assay_links} 條`, `品管↔設定 ${c.qc_assay_links} 條`,
  ].map((t) => `<span class="er-chip">${t}</span>`).join("");

  const i = ER.instrument;
  cols.innerHTML = `
    <div class="er-col t-inst"><div class="er-col-head">儀器</div>
      <div class="er-node t-inst" data-key="inst:${esc(i.serial_number)}">
        <div class="er-title">${esc(i.instrument_name)}</div>
        <div class="er-sub">S/N ${esc(i.serial_number)}<br>${esc(i.section_name)} · ${esc(i.instrument_role)}</div>
      </div></div>
    <div class="er-col t-qc"><div class="er-col-head">品管液</div>
      ${ER.qc_products.length ? ER.qc_products.map((q) => `
        <div class="er-node t-qc" data-key="qc:${esc(q.qc_product_id)}">
          <div class="er-title">${esc(q.product_name)}</div>
          <div class="er-sub">${(q.lots || []).map((l) => `${esc(l.level_code)}·${esc(l.lot_number)}`).join("<br>") || "尚無批號"}</div>
        </div>`).join("") : `<div class="er-empty">尚無品管液</div>`}</div>
    <div class="er-col t-reagent"><div class="er-col-head">試劑</div>
      ${ER.reagents.length ? ER.reagents.map((r) => `
        <div class="er-node t-reagent" data-key="reagent:${esc(r.reagent_product_id)}">
          <div class="er-title">${esc(r.product_name)}</div>
          <div class="er-sub">${(r.lots || []).map((l) => esc(l.lot_number)).join("、") || "尚無批號"}</div>
        </div>`).join("") : `<div class="er-empty">尚無試劑</div>`}</div>
    <div class="er-col t-item"><div class="er-col-head">檢驗設定</div>
      ${ER.assays.length ? ER.assays.map((a) => `
        <div class="er-node t-item" data-key="assay:${esc(a.assay_id)}">
          <div class="er-title">${esc(a.item_code)} <span class="er-tag">${esc(a.specimen_code)}</span></div>
          <div class="er-sub">${esc(a.item_name || "")}${a.result_unit ? " ｜ " + esc(a.result_unit) : ""}</div>
        </div>`).join("") : `<div class="er-empty">尚無檢驗設定</div>`}</div>`;

  document.getElementById("er-detail").innerHTML = `<div class="placeholder">點擊卡片查看詳細資料與關聯</div>`;
  erSelected = null;
  document.getElementById("er-canvas").classList.remove("has-selection");
  cols.querySelectorAll(".er-node").forEach((n) =>
    n.addEventListener("click", () => selectERNode(n.dataset.key)));
  requestAnimationFrame(drawEREdges);
}

function drawEREdges() {
  const svg = document.getElementById("er-edges");
  const canvas = document.getElementById("er-canvas");
  if (!ER || !svg) return;
  const box = canvas.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);
  svg.setAttribute("width", canvas.scrollWidth);
  svg.setAttribute("height", canvas.scrollHeight);
  const anchor = (key, side) => {
    const el = canvas.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (side === "right" ? r.right : r.left) - box.left, y: r.top + r.height / 2 - box.top };
  };
  const css = getComputedStyle(document.documentElement);
  const cQC = css.getPropertyValue("--er-qc").trim();
  const cRg = css.getPropertyValue("--er-reagent").trim();
  const cIt = css.getPropertyValue("--er-item").trim();

  const edges = [];
  ER.qc_products.forEach((q) =>
    edges.push({ from: `inst:${ER.instrument.serial_number}`, to: `qc:${q.qc_product_id}`, color: cQC }));
  ER.edges.qc_reagent.forEach((e) =>
    edges.push({ from: `qc:${e.qc_product_id}`, to: `reagent:${e.reagent_product_id}`, color: cRg }));
  ER.edges.reagent_assay.forEach((e) =>
    edges.push({ from: `reagent:${e.reagent_product_id}`, to: `assay:${e.assay_id}`, color: cIt }));

  svg.innerHTML = edges.map((e) => {
    const a = anchor(e.from, "right"), b = anchor(e.to, "left");
    if (!a || !b) return "";
    const dx = Math.max(24, (b.x - a.x) / 2);
    return `<path class="er-edge" d="M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}"
      stroke="${e.color}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"></path>`;
  }).join("");
  ER._edges = edges;
  if (erSelected) applyERHighlight(erSelected);
}

function erConnected(key) {
  const keys = new Set([key]);
  const edges = ER._edges || [];
  let grew = true;
  while (grew) {
    grew = false;
    edges.forEach((e) => {
      if (keys.has(e.from) && !keys.has(e.to)) { keys.add(e.to); grew = true; }
      if (keys.has(e.to) && !keys.has(e.from)) { keys.add(e.from); grew = true; }
    });
  }
  return keys;
}

function applyERHighlight(key) {
  const canvas = document.getElementById("er-canvas");
  const keys = erConnected(key);
  canvas.classList.add("has-selection");
  canvas.querySelectorAll(".er-node").forEach((n) => {
    n.classList.toggle("hl", keys.has(n.dataset.key));
    n.classList.toggle("root", n.dataset.key === key);
  });
  canvas.querySelectorAll(".er-edge").forEach((p) =>
    p.classList.toggle("hl", keys.has(p.dataset.from) && keys.has(p.dataset.to)));
}

function clearERSelection() {
  const canvas = document.getElementById("er-canvas");
  canvas.classList.remove("has-selection");
  canvas.querySelectorAll(".er-node").forEach((n) => n.classList.remove("hl", "root"));
  canvas.querySelectorAll(".er-edge").forEach((p) => p.classList.remove("hl"));
  erSelected = null;
  document.getElementById("er-detail").innerHTML = `<div class="placeholder">點擊卡片查看詳細資料與關聯</div>`;
}

function selectERNode(key) {
  if (erSelected === key) return clearERSelection();
  erSelected = key;
  applyERHighlight(key);
  renderERDetail(key);
  if (document.getElementById("er-layout").classList.contains("detail-collapsed")) toggleERDetail(false);
}

function renderERDetail(key) {
  const type = key.slice(0, key.indexOf(":")), id = key.slice(key.indexOf(":") + 1);
  const kv = (k, v) => `<div class="er-kv">${k}：<b>${esc(v ?? "-")}</b></div>`;
  let html = "";
  if (type === "inst") {
    const i = ER.instrument;
    html = `<h4>🖥️ ${esc(i.instrument_name)}</h4>${kv("S/N", i.serial_number)}${kv("組別", i.section_name)}
      ${kv("角色", i.instrument_role)}${kv("關聯", `品管液 ${ER.counts.qc_products}｜試劑 ${ER.counts.reagents}｜檢驗設定 ${ER.counts.assays}`)}`;
  } else if (type === "qc") {
    const q = ER.qc_products.find((x) => x.qc_product_id === id);
    const assays = ER.edges.qc_assay.filter((e) => e.qc_product_id === id)
      .map((e) => ER.assays.find((a) => a.assay_id === e.assay_id))
      .filter(Boolean).map((a) => `${a.item_code}/${a.specimen_code}`);
    html = `<h4>🧫 ${esc(q.product_name)}</h4>${kv("廠商", q.manufacturer)}
      ${kv("批號", (q.lots || []).map((l) => `${l.level_code}·${l.lot_number}`).join("、") || "尚無")}
      ${kv("涵蓋檢驗設定", assays.length ? assays.join("、") : "（尚無關聯）")}`;
  } else if (type === "reagent") {
    const r = ER.reagents.find((x) => x.reagent_product_id === id);
    const assays = ER.edges.reagent_assay.filter((e) => e.reagent_product_id === id)
      .map((e) => ER.assays.find((a) => a.assay_id === e.assay_id))
      .filter(Boolean).map((a) => `${a.item_code}/${a.specimen_code}`);
    html = `<h4>🧪 ${esc(r.product_name)}</h4>${kv("廠商", r.manufacturer)}
      ${kv("批號", (r.lots || []).map((l) => `${l.lot_number}${l.expiry_date ? "（效期 " + l.expiry_date + "）" : ""}`).join("、") || "尚無")}
      ${kv("用於檢驗設定", assays.length ? assays.join("、") : "（尚無關聯）")}`;
  } else if (type === "assay") {
    const a = ER.assays.find((x) => x.assay_id === id);
    const rgs = ER.edges.reagent_assay.filter((e) => e.assay_id === id)
      .map((e) => ER.reagents.find((r) => r.reagent_product_id === e.reagent_product_id))
      .filter(Boolean).map((r) => r.product_name);
    const qcs = ER.edges.qc_assay.filter((e) => e.assay_id === id)
      .map((e) => ER.qc_products.find((q) => q.qc_product_id === e.qc_product_id))
      .filter(Boolean).map((q) => q.product_name);
    html = `<h4>🔬 ${esc(a.item_code)} / ${esc(a.specimen_code)}</h4>
      ${kv("全名", a.item_name)}${kv("單位", a.result_unit)}
      ${kv("使用試劑", rgs.length ? rgs.join("、") : "（尚無關聯）")}
      ${kv("品管液", qcs.length ? qcs.join("、") : "（尚無關聯）")}`;
  }
  document.getElementById("er-detail").innerHTML = html;
}

function toggleERDetail(collapsed) {
  document.getElementById("er-layout").classList.toggle("detail-collapsed", collapsed);
  const until = performance.now() + 360;
  const tick = () => { if (ER) drawEREdges(); if (performance.now() < until) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
document.getElementById("er-detail-toggle").addEventListener("click", () => toggleERDetail(true));
document.getElementById("er-detail-open").addEventListener("click", () => toggleERDetail(false));
document.getElementById("er-refresh").addEventListener("click", loadER);
document.getElementById("er-reset").addEventListener("click", clearERSelection);
document.getElementById("er-instrument").addEventListener("change", loadER);
document.getElementById("er-section").addEventListener("change", () => setTimeout(loadER, 0));
if (window.ResizeObserver)
  new ResizeObserver(() => { if (ER) drawEREdges(); }).observe(document.getElementById("er-canvas"));

/* ==================================================== AI 判讀 */
document.getElementById("ai-run").addEventListener("click", async () => {
  const btn = document.getElementById("ai-run");
  const box = document.getElementById("ai-result");
  btn.disabled = true;
  box.innerHTML = `<div class="spinner-wrap"><span class="ai-spinner"></span>AI 判讀中，請稍候…</div>`;
  try {
    const g = (id) => document.getElementById(id).value || null;
    const r = await post("/api/ai-interpret", {
      section_name: g("ai-section"), instrument_serial_number: g("ai-instrument"),
      item_code: g("ai-item"), date_from: g("ai-from"), date_to: g("ai-to"),
    });
    box.innerHTML = `<div class="ai-meta">判讀範圍：${esc(r.scope)}｜筆數：${r.record_count}｜模型：${esc(r.model)}</div>
      <div class="ai-md">${renderMarkdown(r.interpretation)}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="placeholder">❌ 判讀失敗：${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
});

function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(md).split("\n");
  let html = "", list = null, i = 0;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[-:\s|]+\|$/.test(lines[i + 1].trim())) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      html += "<table><thead><tr>" + cells(t).map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        html += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++;
      }
      html += "</tbody></table>"; continue;
    }
    if (/^#{1,3}\s/.test(t)) { closeList(); const l = t.match(/^#+/)[0].length;
      html += `<h${l}>${inline(t.replace(/^#+\s/, ""))}</h${l}>`; }
    else if (/^[-*]\s/.test(t)) { if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(t.replace(/^[-*]\s/, ""))}</li>`; }
    else if (/^\d+\.\s/.test(t)) { if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(t.replace(/^\d+\.\s/, ""))}</li>`; }
    else if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); html += "<hr>"; }
    else if (t === "") closeList();
    else { closeList(); html += `<p>${inline(t)}</p>`; }
    i++;
  }
  closeList();
  return html;
}

/* ==================================================== 各頁面初始化掛勾 */
Object.assign(VIEW_INIT, {
  dashboard: () => loadDashboard(),
  "qc-run": (first) => { if (first) loadRunLots(); },
  "qc-results": (first) => { if (first) loadResults(); },
  lj: async (first) => { if (first) { await loadLJItems(); loadLJ(); } else drawLJ(); },
  calibration: (first) => { if (first) loadCalibrations(); },
  assays: (first) => { if (first) loadAssays(); },
  "qc-targets": (first) => { if (first) loadTargets(); },
  er: (first) => { if (first) loadER(); else requestAnimationFrame(drawEREdges); },
  products: (first) => { if (first) loadProducts(); },
  "reagent-loads": (first) => { if (first) loadLoads(); },
  instruments: (first) => { if (first) loadInstrumentsPage(); },
  "test-items": (first) => { if (first) loadTestItems(); },
  "specimen-types": (first) => { if (first) loadSpecimens(); },
  sections: (first) => { if (first) loadSections(); },
});

/* ==================================================== 啟動 */
(async function init() {
  const t = todayStr();
  const ago = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  ["dash-date"].forEach((id) => (document.getElementById(id).value = t));
  ["res-from", "lj-from", "ai-from", "cal-from"].forEach((id) => (document.getElementById(id).value = ago));
  ["res-to", "lj-to", "ai-to", "cal-to"].forEach((id) => (document.getElementById(id).value = t));
  document.getElementById("run-at").value = nowLocal();
  try {
    await loadMasters();
    loadDashboard();
  } catch (e) {
    toast("主檔載入失敗：" + e.message, "err");
  }
})();
