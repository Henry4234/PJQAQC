// QAQC 前端邏輯：與 FastAPI 後端 (/api/*) 溝通，渲染儀表板、紀錄、新增表單。
const API = ""; // 與後端同源；若分開部署可改成 http://localhost:8000

// ---------- 側欄選單切換 ----------
const navLinks = document.querySelectorAll(".nav-link[data-view]");
const views = document.querySelectorAll(".view");
navLinks.forEach((t) => {
  t.addEventListener("click", () => {
    if (t.classList.contains("disabled")) return;
    navLinks.forEach((x) => x.classList.remove("active"));
    views.forEach((v) => v.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("view-" + t.dataset.view).classList.add("active");
    if (t.dataset.view === "records") loadRecords();
    if (t.dataset.view === "lj") openLJ();
    if (t.dataset.view === "er") openER();
    if (t.dataset.view === "ai") openAI();
    if (t.dataset.view === "add-specimen") loadSpecimenTable();
    if (t.dataset.view.startsWith("mg-")) openManage(t.dataset.view);
  });
});

// 第一層群組收折
document.querySelectorAll(".nav-group-title").forEach((btn) => {
  btn.addEventListener("click", () => btn.parentElement.classList.toggle("open"));
});

// 整個側欄收合
document.getElementById("sidebar-toggle").addEventListener("click", () => {
  document.querySelector(".layout").classList.toggle("sidebar-collapsed");
});

// ---------- 亮 / 暗色模式 ----------
const themeToggle = document.getElementById("theme-toggle");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  localStorage.setItem("qaqc-theme", theme);
  // L-J chart 以繪圖時的主題色渲染，主題切換後重繪（鉤子於 L-J 區段註冊）
  if (window.__redrawLJ) window.__redrawLJ();
}
themeToggle.addEventListener("change", () => applyTheme(themeToggle.checked ? "light" : "dark"));
applyTheme(localStorage.getItem("qaqc-theme") || "dark");

const todayStr = () => new Date().toISOString().slice(0, 10);

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || res.statusText);
  }
  return res.json();
}

// ---------- Dashboard ----------
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

    // 違規明細
    const vl = document.getElementById("violation-list");
    if (!d.violations.length) {
      vl.innerHTML = `<div class="empty">✅ 今日無 Westgard 規則違規</div>`;
    } else {
      vl.innerHTML = d.violations
        .map(
          (v) => `
        <div class="vrow">
          <div class="vhead">
            <span class="vtitle">${v.instrument_name} · ${v.test_item} (${v.qc_level ?? ""})</span>
            <span class="badge ${v.qc_status}">${v.qc_status}</span>
          </div>
          <div class="vmeta">時間 ${v.qc_time ?? "-"} ｜ Z-score ${v.z_score ?? "-"} ｜ 規則 <span class="wg">${v.westgard_rule_violation}</span></div>
          <div class="vremark">${v.remark ?? ""}</div>
        </div>`
        )
        .join("");
    }

    // 規則長條
    const rb = document.getElementById("rule-bars");
    const rules = Object.entries(d.rule_counts);
    if (!rules.length) {
      rb.innerHTML = `<div class="empty">無</div>`;
    } else {
      const max = Math.max(...rules.map((r) => r[1]));
      rb.innerHTML = rules
        .map(
          ([name, cnt]) => `
        <div class="bar-row">
          <span class="bar-label">${name}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(cnt / max) * 100}%"></span></span>
          <span class="bar-count">${cnt}</span>
        </div>`
        )
        .join("");
    }

    // 各儀器
    const il = document.getElementById("instrument-list");
    const inst = Object.entries(d.by_instrument);
    il.innerHTML = inst.length
      ? inst
          .map(
            ([name, s]) => `
        <div class="irow">
          <span>${name}</span>
          <span class="ipill ${s.fail ? "bad" : ""}">${s.total} 次 ／ 失敗 ${s.fail}</span>
        </div>`
          )
          .join("")
      : `<div class="empty">無資料</div>`;
  } catch (e) {
    document.getElementById("violation-list").innerHTML = `<div class="empty">載入失敗：${e.message}</div>`;
  }
}

document.getElementById("dash-refresh").addEventListener("click", loadDashboard);
document.getElementById("dash-date").addEventListener("change", loadDashboard);

// ---------- 儀器主檔（雙層選單資料來源）----------
let INSTRUMENTS = { groups: {}, all: [] };

async function loadInstruments() {
  INSTRUMENTS = await api("/api/instruments");
  const groups = Object.keys(INSTRUMENTS.groups);

  // 紀錄分頁：組別選單
  const recGroup = document.getElementById("rec-group");
  recGroup.innerHTML =
    `<option value="">全部組別</option>` +
    groups.map((g) => `<option value="${g}">${g}</option>`).join("");

  // 新增分頁：組別選單
  const addGroup = document.getElementById("add-group");
  addGroup.innerHTML = groups.map((g) => `<option value="${g}">${g}</option>`).join("");

  // L-J 分頁：組別選單（不含「全部」，需指定單一儀器）
  const ljGroup = document.getElementById("lj-group");
  ljGroup.innerHTML = groups.map((g) => `<option value="${g}">${g}</option>`).join("");

  // 關聯圖 / 三個管理頁 / 新批號頁：組別選單（需指定單一儀器）
  ["er-group", "mg-item-group", "mg-reagent-group", "mg-rqc-group", "lot-group"].forEach((gid) => {
    const sel = document.getElementById(gid);
    const prev = sel.value;
    sel.innerHTML = groups.map((g) => `<option value="${g}">${g}</option>`).join("");
    if (groups.includes(prev)) sel.value = prev;
    fillInstrumentSelect(gid.replace("-group", "-instrument"), sel.value || groups[0] || "", false);
  });

  // AI 分頁：組別選單（含「全部組別」）
  const aiGroup = document.getElementById("ai-group");
  aiGroup.innerHTML =
    `<option value="">全部組別</option>` +
    groups.map((g) => `<option value="${g}">${g}</option>`).join("");

  fillInstrumentSelect("rec-instrument", "", true); // 全部
  fillInstrumentSelect("add-instrument", groups[0] || "", false);
  fillInstrumentSelect("lj-instrument", groups[0] || "", false);
  fillInstrumentSelect("ai-instrument", "", true); // 全部
  // 新增檢驗項目 / 試劑 / 品管液 表單：雙層選單（組別 → 該組儀器）
  const groupOpts = groups.map((g) => `<option value="${g}">${g}</option>`).join("");
  [
    ["reg-item-group", "reg-item-instrument"],
    ["reg-reagent-group", "reg-reagent-instrument"],
    ["reg-rqc-group", "reg-rqc-instrument"],
  ].forEach(([groupId, instId]) => {
    const sel = document.getElementById(groupId);
    const prev = sel.value;
    sel.innerHTML = groupOpts;
    // 儀器主檔重載後盡量保留原本選的組別
    if (groups.includes(prev)) sel.value = prev;
    fillInstrumentSelect(instId, sel.value || groups[0] || "", false);
  });
  loadReagentItemOptions();
  loadRQCItemOptions();
  reloadLinkOptions("all");
  syncAddInstrumentMeta();
}

// 依組別填入第二層儀器選單；includeAll=true 時加入「全部儀器」選項
function fillInstrumentSelect(selectId, group, includeAll) {
  const sel = document.getElementById(selectId);
  const list = group ? INSTRUMENTS.groups[group] || [] : INSTRUMENTS.all;
  const opts = list
    .map(
      (i) =>
        `<option value="${i.serial_number}">${i.instrument_name}（${i.machine_role}） · ${i.serial_number}</option>`
    )
    .join("");
  sel.innerHTML = (includeAll ? `<option value="">全部儀器</option>` : "") + opts;
}

// 新增分頁：依選中的儀器自動帶入 instrument_name
function syncAddInstrumentMeta() {
  const sn = document.getElementById("add-instrument").value;
  const inst = INSTRUMENTS.all.find((i) => i.serial_number === sn);
  document.getElementById("add-instrument-name").value = inst ? inst.instrument_name : "";
}

// 紀錄分頁：組別變動時連動第二層
document.getElementById("rec-group").addEventListener("change", (e) => {
  fillInstrumentSelect("rec-instrument", e.target.value, true);
});
// 新增分頁：組別 / 儀器連動
document.getElementById("add-group").addEventListener("change", (e) => {
  fillInstrumentSelect("add-instrument", e.target.value, false);
  syncAddInstrumentMeta();
});
document.getElementById("add-instrument").addEventListener("change", syncAddInstrumentMeta);
// 新增檢驗項目 / 試劑 / 品管液：組別變動時連動儀器選單
[
  ["reg-item-group", "reg-item-instrument"],
  ["reg-reagent-group", "reg-reagent-instrument"],
  ["reg-rqc-group", "reg-rqc-instrument"],
].forEach(([groupId, instId]) => {
  document.getElementById(groupId).addEventListener("change", (e) => {
    fillInstrumentSelect(instId, e.target.value, false);
  });
});

// 第三層選單共用：依所選儀器載入該儀器的檢驗項目（來自 items 主檔）
// option 上帶 data-full-name，供「項目全名」自動帶入使用
async function loadItemOptionsFor(instrumentSelectId, itemSelectId) {
  const sn = document.getElementById(instrumentSelectId).value;
  const sel = document.getElementById(itemSelectId);
  if (!sn) {
    sel.innerHTML = `<option value="" disabled selected>（請先選擇儀器）</option>`;
    return;
  }
  try {
    const items = await api(`/api/items?instrument_serial_number=${encodeURIComponent(sn)}`);
    sel.innerHTML = items.length
      ? items
          .map((i) =>
            `<option value="${esc(i.item_code)}" data-full-name="${esc(i.item_name || "")}" data-unit="${esc(i.unit || "")}">` +
            `${esc(i.item_code)}${i.item_name ? "（" + esc(i.item_name) + "）" : ""}</option>`
          )
          .join("")
      : `<option value="" disabled selected>（此儀器尚無項目，請先新增檢驗項目）</option>`;
  } catch {
    sel.innerHTML = `<option value="" disabled selected>（項目載入失敗）</option>`;
  }
}

// 新增試劑：組別 → 儀器 → 檢驗項目
const loadReagentItemOptions = () =>
  loadItemOptionsFor("reg-reagent-instrument", "reg-reagent-item");
document.getElementById("reg-reagent-group").addEventListener("change", loadReagentItemOptions);
document.getElementById("reg-reagent-instrument").addEventListener("change", loadReagentItemOptions);

// ---------- 可檢索的下拉複選元件 ----------
// 用法：msRender(containerId, options[{value,label}], placeholder, selected[])
// 取值：checkedLinks(containerId)
function msRender(containerId, options, placeholder = "（無可選項目）", selected = []) {
  const box = document.getElementById(containerId);
  box.classList.add("ms");
  if (!options.length) {
    box.classList.remove("ms");
    box.innerHTML = `<span class="check-empty">${esc(placeholder)}</span>`;
    return;
  }
  const picked = new Set(selected || []);
  box.innerHTML = `
    <button type="button" class="ms-toggle">
      <span class="ms-label empty">請選擇…</span>
      <span class="ms-count" hidden>0</span>
      <span class="ms-caret">▾</span>
    </button>
    <div class="ms-panel">
      <div class="ms-search-wrap">
        <input type="text" class="ms-search" placeholder="輸入關鍵字檢索…" />
      </div>
      <div class="ms-bulk">
        <button type="button" data-all>全選（符合檢索）</button>
        <button type="button" data-none>清除選取</button>
        <span class="ms-shown"></span>
      </div>
      <div class="ms-options">
        ${options.map((o) =>
          `<label data-text="${esc((o.label || "").toLowerCase())}" data-raw="${esc(o.label)}">
             <input type="checkbox" data-link value="${esc(o.value)}" ${picked.has(o.value) ? "checked" : ""} />
             <span>${esc(o.label)}</span>
           </label>`).join("")}
      </div>
    </div>`;

  const toggle = box.querySelector(".ms-toggle");
  const panel = box.querySelector(".ms-panel");
  const search = box.querySelector(".ms-search");
  const labels = [...box.querySelectorAll(".ms-options label")];
  const shown = box.querySelector(".ms-shown");
  const optBox = box.querySelector(".ms-options");
  let active = -1; // 鍵盤游標位置（對應可見項目）

  // 收合列顯示已選項目與數量
  const refresh = () => {
    const picked = [...box.querySelectorAll("[data-link]:checked")];
    const lab = box.querySelector(".ms-label");
    const cnt = box.querySelector(".ms-count");
    if (picked.length) {
      lab.textContent = picked.map((c) => c.parentElement.dataset.raw).join("、");
      lab.classList.remove("empty");
      cnt.hidden = false;
      cnt.textContent = picked.length;
    } else {
      lab.textContent = "請選擇…";
      lab.classList.add("empty");
      cnt.hidden = true;
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

  // 依關鍵字過濾，並在符合處加上 <mark> 標示
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    let n = 0;
    labels.forEach((l) => {
      const raw = l.dataset.raw;
      const hit = !q || l.dataset.text.includes(q);
      l.hidden = !hit;
      const span = l.querySelector("span");
      if (hit && q) {
        const at = l.dataset.text.indexOf(q);
        span.innerHTML =
          esc(raw.slice(0, at)) + "<mark>" + esc(raw.slice(at, at + q.length)) + "</mark>" +
          esc(raw.slice(at + q.length));
      } else {
        span.textContent = raw;
      }
      if (hit) n++;
    });
    shown.textContent = q ? `符合 ${n} / ${labels.length} 項` : `共 ${labels.length} 項`;
    if (!n) {
      if (!optBox.querySelector(".ms-none"))
        optBox.insertAdjacentHTML("beforeend", `<div class="ms-none">查無符合「${esc(search.value)}」的項目</div>`);
      else optBox.querySelector(".ms-none").textContent = `查無符合「${search.value}」的項目`;
      optBox.querySelector(".ms-none").hidden = false;
    } else if (optBox.querySelector(".ms-none")) {
      optBox.querySelector(".ms-none").hidden = true;
    }
    setActive(0);
  };

  const open = (yes) => {
    box.classList.toggle("open", yes);
    if (yes) { search.value = ""; filter(); search.focus(); }
  };

  toggle.addEventListener("click", () => open(!box.classList.contains("open")));
  search.addEventListener("input", filter);

  // 鍵盤操作：↑↓ 移動、Enter 勾選/取消、Esc 關閉
  search.addEventListener("keydown", (e) => {
    const vis = visible();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (vis[active]) {
        const cb = vis[active].querySelector("input");
        cb.checked = !cb.checked;
        refresh();
      }
    } else if (e.key === "Escape") { e.preventDefault(); open(false); toggle.focus(); }
  });

  panel.addEventListener("click", (e) => e.stopPropagation()); // 面板內點擊不關閉
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target)) box.classList.remove("open");
  });
  box.addEventListener("change", refresh);
  box.querySelector("[data-all]").addEventListener("click", () => {
    visible().forEach((l) => (l.querySelector("input").checked = true));
    refresh();
  });
  box.querySelector("[data-none]").addEventListener("click", () => {
    labels.forEach((l) => (l.querySelector("input").checked = false));
    refresh();
  });
  filter();
  refresh();
}

// 中介表關聯的候選來源設定（新增頁與管理頁編輯對話框共用）
const LINK_KINDS = {
  items: {
    path: "/api/items",
    key: "item_id",
    label: (r) => `${r.item_code}${r.item_name ? "（" + r.item_name + "）" : ""}`,
    empty: "此儀器尚無檢驗項目，可先於「新增檢驗項目」建立",
  },
  reagents: {
    path: "/api/reagents",
    key: "reagent_id",
    label: (r) => `${r.reagent_name}（${r.lot_number}）`,
    empty: "此儀器尚無試劑，可先於「新增試劑」建立",
  },
  qcs: {
    path: "/api/reagent-qc",
    key: "reagent_qc_id",
    label: (r) => `${r.test_item} ${r.qc_level}${r.qc_lot_number ? "（" + r.qc_lot_number + "）" : "（尚未進批）"}`,
    empty: "此儀器尚無品管液，可先於「新增品管液」建立",
  },
};

// 取某台儀器可關聯的候選清單
async function fetchLinkOptions(kind, sn) {
  const conf = LINK_KINDS[kind];
  const rows = await api(`${conf.path}?instrument_serial_number=${encodeURIComponent(sn)}`);
  return rows.map((r) => ({ value: r[conf.key], label: conf.label(r) }));
}

// 依所選儀器載入候選項目，value 為該主檔的 UUID
async function loadLinkCheckboxes(containerId, instrumentSelectId, kind) {
  const box = document.getElementById(containerId);
  const sn = document.getElementById(instrumentSelectId).value;
  if (!sn) {
    box.classList.remove("ms");
    box.innerHTML = `<span class="check-empty">請先選擇儀器</span>`;
    return;
  }
  try {
    msRender(containerId, await fetchLinkOptions(kind, sn), LINK_KINDS[kind].empty);
  } catch (e) {
    box.classList.remove("ms");
    box.innerHTML = `<span class="check-empty">載入失敗：${esc(e.message)}</span>`;
  }
}

// 取出某複選群組已勾選的 ID
const checkedLinks = (containerId) =>
  [...document.querySelectorAll(`#${containerId} [data-link]:checked`)].map((c) => c.value);

// 新增品管液：組別 → 儀器 → 檢驗項目，並自動帶入項目全名
async function loadRQCItemOptions() {
  await loadItemOptionsFor("reg-rqc-instrument", "reg-rqc-item");
  syncRQCItemFullName();
}
// 依選取的檢驗項目帶入項目全名（仍可手動修改）
function syncRQCItemFullName() {
  const sel = document.getElementById("reg-rqc-item");
  const opt = sel.selectedOptions[0];
  document.getElementById("reg-rqc-item-full").value = opt ? opt.dataset.fullName || "" : "";
}
document.getElementById("reg-rqc-group").addEventListener("change", loadRQCItemOptions);
document.getElementById("reg-rqc-instrument").addEventListener("change", loadRQCItemOptions);
document.getElementById("reg-rqc-item").addEventListener("change", syncRQCItemFullName);

// 三個新增頁的中介表關聯複選清單：隨所選儀器連動
function reloadLinkOptions(page) {
  if (page === "item" || page === "all")
    loadLinkCheckboxes("reg-item-reagents", "reg-item-instrument", "reagents");
  if (page === "reagent" || page === "all") {
    loadLinkCheckboxes("reg-reagent-items", "reg-reagent-instrument", "items");
    loadLinkCheckboxes("reg-reagent-qcs", "reg-reagent-instrument", "qcs");
  }
  if (page === "rqc" || page === "all")
    loadLinkCheckboxes("reg-rqc-reagents", "reg-rqc-instrument", "reagents");
}
[
  ["reg-item-group", "reg-item-instrument", "item"],
  ["reg-reagent-group", "reg-reagent-instrument", "reagent"],
  ["reg-rqc-group", "reg-rqc-instrument", "rqc"],
].forEach(([groupId, instId, page]) => {
  document.getElementById(groupId).addEventListener("change", () => reloadLinkOptions(page));
  document.getElementById(instId).addEventListener("change", () => reloadLinkOptions(page));
});

// ---------- Records ----------
async function loadRecords() {
  const from = document.getElementById("rec-from").value;
  const to = document.getElementById("rec-to").value;
  const group = document.getElementById("rec-group").value;
  const sn = document.getElementById("rec-instrument").value;

  const params = new URLSearchParams({ limit: "1000" });
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  if (sn) params.set("instrument_serial_number", sn);
  else if (group) params.set("lab_group", group);

  const tbody = document.querySelector("#records-table tbody");
  try {
    const rows = await api("/api/records?" + params.toString());
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="12" class="empty">無資料</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `
      <tr>
        <td>${r.qc_date}</td><td>${r.qc_time}</td><td>${r.instrument_name}</td>
        <td>${r.test_item}</td><td>${r.qc_level ?? ""}</td>
        <td>${r.qc_result_value ?? ""}</td><td>${r.unit ?? ""}</td>
        <td>${r.lot_mean ?? ""}</td><td>${r.lot_standard_deviation ?? ""}</td>
        <td>${r.z_score ?? ""}</td>
        <td><span class="badge ${r.qc_status}">${r.qc_status}</span></td>
        <td class="wg">${r.westgard_rule_violation ?? "-"}</td>
      </tr>`
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty">載入失敗：${e.message}</td></tr>`;
  }
}

document.getElementById("rec-refresh").addEventListener("click", () => loadRecords());
document.getElementById("rec-reset").addEventListener("click", () => {
  document.getElementById("rec-from").value = "";
  document.getElementById("rec-to").value = "";
  document.getElementById("rec-group").value = "";
  fillInstrumentSelect("rec-instrument", "", true);
  loadRecords();
});

// ---------- Levey-Jennings Chart ----------
let ljInited = false;
// 主題切換時重繪（applyTheme 呼叫）
window.__redrawLJ = () => { if (ljInited) loadLJ(); };

// 載入選定儀器的檢驗項目到 lj-test
async function loadLJTestItems() {
  const sn = document.getElementById("lj-instrument").value;
  const sel = document.getElementById("lj-test");
  if (!sn) {
    sel.innerHTML = "";
    return;
  }
  const items = await api(`/api/test-items?instrument_serial_number=${encodeURIComponent(sn)}`);
  const prev = sel.value;
  sel.innerHTML = items
    .map((i) => `<option value="${i.test_item}">${i.test_item}${i.test_item_full_name ? "（" + i.test_item_full_name + "）" : ""}</option>`)
    .join("");
  if (items.some((i) => i.test_item === prev)) sel.value = prev;
}

// 抓資料並依 level 分組繪圖
async function loadLJ() {
  const from = document.getElementById("lj-from").value;
  const to = document.getElementById("lj-to").value;
  const sn = document.getElementById("lj-instrument").value;
  const test = document.getElementById("lj-test").value;
  const container = document.getElementById("lj-charts");

  if (!sn || !test) {
    container.innerHTML = `<div class="empty">請選擇儀器與檢驗項目</div>`;
    return;
  }

  const params = new URLSearchParams({ limit: "2000", instrument_serial_number: sn, test_item: test });
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);

  try {
    const rows = await api("/api/records?" + params.toString());
    if (!rows.length) {
      container.innerHTML = `<div class="empty">此條件下無資料</div>`;
      return;
    }
    // 依 qc_level 分組（2 或 3 個 level 各一張圖）
    const byLevel = {};
    rows.forEach((r) => {
      (byLevel[r.qc_level || "(未分級)"] ||= []).push(r);
    });
    const levels = Object.keys(byLevel).sort();
    container.innerHTML = "";
    levels.forEach((lvl) => {
      const pts = byLevel[lvl]
        .map((r) => ({
          date: r.qc_date,
          time: r.qc_time,
          value: Number(r.qc_result_value),
          z: r.z_score,
          status: r.qc_status,
        }))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      // 以最新一筆的 mean / sd 當作此 level 的中心線與 SD
      const last = byLevel[lvl][byLevel[lvl].length - 1];
      const ref = byLevel[lvl].reduce((acc, r) => (r.qc_date >= acc.qc_date ? r : acc), byLevel[lvl][0]);
      container.appendChild(
        renderLJChart({
          testItem: test,
          level: lvl,
          unit: ref.unit || "",
          mean: Number(ref.lot_mean),
          sd: Number(ref.lot_standard_deviation),
          points: pts,
        })
      );
    });
  } catch (e) {
    container.innerHTML = `<div class="empty">載入失敗：${e.message}</div>`;
  }
}

// 用 SVG 繪製單張 L-J 圖（含 mean、±1/±2/±3 SD 線）
function renderLJChart({ testItem, level, unit, mean, sd, points }) {
  const W = 920, H = 340;
  const m = { top: 20, right: 96, bottom: 48, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const yMax = mean + 4 * sd;
  const yMin = mean - 4 * sd;
  const yToPx = (v) => m.top + ((yMax - v) / (yMax - yMin)) * plotH;
  const n = points.length;
  const xToPx = (i) => (n === 1 ? m.left + plotW / 2 : m.left + (i / (n - 1)) * plotW);

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });

  // 背景繪圖區（顏色跟隨主題）
  const css = getComputedStyle(document.documentElement);
  const chartBg = css.getPropertyValue("--chart-bg").trim() || "#16202f";
  const chartBorder = css.getPropertyValue("--border").trim() || "#334155";
  const pointStroke = css.getPropertyValue("--chart-point-stroke").trim() || "#0f172a";
  svg.appendChild(el("rect", { x: m.left, y: m.top, width: plotW, height: plotH, fill: chartBg, stroke: chartBorder }));

  // SD 參考線
  const lines = [
    { k: 3, color: "#ef4444", label: "+3SD" },
    { k: 2, color: "#f59e0b", label: "+2SD" },
    { k: 1, color: "#7c8aa0", label: "+1SD" },
    { k: 0, color: "#22c55e", label: "Mean" },
    { k: -1, color: "#7c8aa0", label: "-1SD" },
    { k: -2, color: "#f59e0b", label: "-2SD" },
    { k: -3, color: "#ef4444", label: "-3SD" },
  ];
  lines.forEach((ln) => {
    const v = mean + ln.k * sd;
    const y = yToPx(v);
    svg.appendChild(
      el("line", {
        x1: m.left, y1: y, x2: m.left + plotW, y2: y,
        stroke: ln.color, "stroke-width": ln.k === 0 ? 1.6 : 1,
        "stroke-dasharray": ln.k === 0 ? "" : "5 4", opacity: ln.k === 0 ? 0.95 : 0.7,
      })
    );
    // 右側標籤（SD 等級 + 數值）
    svg.appendChild(el("text", { x: m.left + plotW + 8, y: y + 4, fill: ln.color, "font-size": 11 }, `${ln.label} ${v.toFixed(2)}`));
  });

  // 連線
  if (n > 1) {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xToPx(i).toFixed(1)},${yToPx(p.value).toFixed(1)}`).join(" ");
    svg.appendChild(el("path", { d, fill: "none", stroke: "#38bdf8", "stroke-width": 1.4, opacity: 0.85 }));
  }

  // 資料點
  const statusColor = { Pass: "#22c55e", Warning: "#f59e0b", Fail: "#ef4444" };
  points.forEach((p, i) => {
    const cx = xToPx(i), cy = yToPx(p.value);
    const c = el("circle", { cx, cy, r: 4.5, fill: statusColor[p.status] || "#38bdf8", stroke: pointStroke, "stroke-width": 1 });
    c.appendChild(el("title", {}, `${p.date} ${p.time}\n值 ${p.value} ${unit}\nZ=${p.z} ｜ ${p.status}`));
    svg.appendChild(c);

    // X 軸日期標籤（點多時稀疏顯示）
    const step = Math.max(1, Math.ceil(n / 9));
    if (i % step === 0 || i === n - 1) {
      const md = p.date.slice(5).replace("-", "/");
      svg.appendChild(el("text", { x: cx, y: H - m.bottom + 18, fill: "#94a3b8", "font-size": 10, "text-anchor": "middle" }, md));
    }
  });

  // 卡片外框
  const card = document.createElement("div");
  card.className = "lj-chart";
  const h3 = document.createElement("h3");
  h3.textContent = `${testItem} · ${level}`;
  const sub = document.createElement("div");
  sub.className = "lj-sub";
  sub.textContent = `Mean ${mean} ${unit} ｜ SD ${sd} ｜ 共 ${n} 點`;
  card.appendChild(h3);
  card.appendChild(sub);
  card.appendChild(svg);
  return card;
}

// L-J 分頁事件連動
document.getElementById("lj-group").addEventListener("change", async (e) => {
  fillInstrumentSelect("lj-instrument", e.target.value, false);
  await loadLJTestItems();
  loadLJ();
});
document.getElementById("lj-instrument").addEventListener("change", async () => {
  await loadLJTestItems();
  loadLJ();
});
document.getElementById("lj-test").addEventListener("change", loadLJ);
document.getElementById("lj-refresh").addEventListener("click", loadLJ);

async function openLJ() {
  if (!ljInited) {
    await loadLJTestItems();
    ljInited = true;
  }
  loadLJ();
}

// ---------- AI 判讀 ----------
let aiInited = false;

// 載入檢驗項目（含「全部項目」）到 ai-test；儀器留空時取全部項目
async function loadAITestItems() {
  const sn = document.getElementById("ai-instrument").value;
  const sel = document.getElementById("ai-test");
  const path = sn
    ? `/api/test-items?instrument_serial_number=${encodeURIComponent(sn)}`
    : "/api/test-items";
  const items = await api(path);
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">全部項目</option>` +
    items
      .map((i) => `<option value="${i.test_item}">${i.test_item}${i.test_item_full_name ? "（" + i.test_item_full_name + "）" : ""}</option>`)
      .join("");
  if (items.some((i) => i.test_item === prev)) sel.value = prev;
}

document.getElementById("ai-group").addEventListener("change", async (e) => {
  fillInstrumentSelect("ai-instrument", e.target.value, true);
  await loadAITestItems();
});
document.getElementById("ai-instrument").addEventListener("change", loadAITestItems);

document.getElementById("ai-run").addEventListener("click", async () => {
  const result = document.getElementById("ai-result");
  const btn = document.getElementById("ai-run");
  const payload = {
    lab_group: document.getElementById("ai-group").value || null,
    instrument_serial_number: document.getElementById("ai-instrument").value || null,
    date_from: document.getElementById("ai-from").value || null,
    date_to: document.getElementById("ai-to").value || null,
    test_item: document.getElementById("ai-test").value || null,
  };

  btn.disabled = true;
  result.innerHTML = `<div class="spinner-wrap"><span class="ai-spinner"></span>AI 判讀中，請稍候…（模型分析中，可能需數十秒）</div>`;
  try {
    const r = await api("/api/ai-interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    result.innerHTML =
      `<div class="ai-meta">判讀範圍：${r.scope}｜資料筆數：${r.record_count}｜模型：${r.model}</div>` +
      `<div class="ai-md">${renderMarkdown(r.interpretation)}</div>`;
  } catch (e) {
    result.innerHTML = `<div class="placeholder">❌ 判讀失敗：${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
});

function openAI() {
  if (!aiInited) {
    loadAITestItems();
    aiInited = true;
    document.getElementById("ai-result").innerHTML =
      `<div class="placeholder">設定查詢條件後，點擊右上方「AI 判讀」開始分析。</div>`;
  }
}

// 極簡 Markdown → HTML（標題、粗體、行內 code、清單、表格、水平線）
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = md.split("\n");
  let html = "";
  let i = 0;
  let listType = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 表格（| ... |，下一行為分隔列）
    if (/^\|.*\|$/.test(trimmed) && i + 1 < lines.length && /^\|[-:\s|]+\|$/.test(lines[i + 1].trim())) {
      closeList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headers = cells(trimmed);
      html += "<table><thead><tr>" + headers.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        html += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      html += "</tbody></table>";
      continue;
    }

    if (/^#{1,3}\s/.test(trimmed)) {
      closeList();
      const level = trimmed.match(/^#+/)[0].length;
      html += `<h${level}>${inline(trimmed.replace(/^#+\s/, ""))}</h${level}>`;
    } else if (/^[-*]\s/.test(trimmed)) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${inline(trimmed.replace(/^[-*]\s/, ""))}</li>`;
    } else if (/^\d+\.\s/.test(trimmed)) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${inline(trimmed.replace(/^\d+\.\s/, ""))}</li>`;
    } else if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeList();
      html += "<hr>";
    } else if (trimmed === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(trimmed)}</p>`;
    }
    i++;
  }
  closeList();
  return html;
}

// ---------- Add form ----------
document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("add-msg");
  msg.textContent = "送出中…";
  msg.className = "add-msg";

  const fd = new FormData(e.target);
  const payload = {};
  for (const [k, v] of fd.entries()) {
    if (v === "") continue;
    payload[k] = v;
  }
  // 數值欄位轉型
  ["qc_result_value", "lot_mean", "lot_standard_deviation", "acceptable_range_lower", "acceptable_range_upper"].forEach((k) => {
    if (payload[k] !== undefined) payload[k] = parseFloat(payload[k]);
  });

  try {
    const r = await api("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    msg.className = "add-msg ok";
    msg.textContent = `✅ 新增成功！Z-score=${r.z_score}，狀態=${r.qc_status}` + (r.westgard_rule_violation ? `，Westgard=${r.westgard_rule_violation}` : "");
    loadDashboard();
  } catch (err) {
    msg.className = "add-msg err";
    msg.textContent = "❌ 失敗：" + err.message;
  }
});

// ---------- 新增主檔（儀器 / 項目 / 試劑 / 品管液 / 檢體類別）----------
// 共用：FormData → JSON payload；checkboxes 轉布林、numbers 轉數字
function formPayload(form, { checkboxes = [], numbers = [] } = {}) {
  const fd = new FormData(form);
  const payload = {};
  for (const [k, v] of fd.entries()) {
    if (v === "") continue;
    payload[k] = v;
  }
  checkboxes.forEach((k) => {
    payload[k] = form.querySelector(`[name=${k}]`)?.checked ?? false;
  });
  numbers.forEach((k) => {
    if (payload[k] !== undefined) payload[k] = parseFloat(payload[k]);
  });
  return payload;
}

// 共用：送出表單到 register API 並顯示結果
function bindRegisterForm(formId, msgId, path, options = {}, onSuccess) {
  document.getElementById(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById(msgId);
    msg.className = "add-msg";
    msg.textContent = "送出中…";
    try {
      const payload = formPayload(e.target, options);
      if (options.transform) options.transform(payload, e.target);
      const r = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      msg.className = "add-msg ok";
      msg.textContent = "✅ 新增成功！";
      e.target.reset();
      if (onSuccess) onSuccess(r);
    } catch (err) {
      msg.className = "add-msg err";
      // 後端錯誤格式為 {"detail": "..."}，嘗試取出可讀訊息
      let text = err.message;
      try { text = JSON.parse(err.message).detail || text; } catch {}
      msg.textContent = "❌ 失敗：" + text;
    }
  });
}

// 組別選單（新增儀器表單）
async function loadLabGroupOptions() {
  const groups = await api("/api/lab-groups");
  document.getElementById("reg-inst-group").innerHTML = groups
    .map((g) => `<option value="${g.group_name}">${g.group_name}</option>`)
    .join("");
}

// 檢體類別：試劑表單的複選框 + 品管液表單的下拉 + 檢體類別頁的清單表格
async function loadSpecimenOptions() {
  const types = await api("/api/specimen-types");
  SPECIMEN_TYPES = types; // 管理頁編輯對話框共用
  msRender(
    "reg-reagent-specimens",
    types.map((s) => ({ value: s.code, label: `${s.code}（${s.name}）` })),
    "尚無檢體類別"
  );
  const opts = types.map((s) => `<option value="${s.code}">${s.code}（${s.name}）</option>`).join("");
  document.getElementById("reg-rqc-specimen").innerHTML = opts;
  document.getElementById("lot-specimen").innerHTML = opts;
}

async function loadSpecimenTable() {
  const tbody = document.querySelector("#specimen-table tbody");
  try {
    const types = await api("/api/specimen-types");
    tbody.innerHTML = types
      .map((s) => `<tr><td>${s.code}</td><td>${s.name}</td><td>${s.description ?? ""}</td></tr>`)
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty">載入失敗：${e.message}</td></tr>`;
  }
}

// 1) 新增儀器：成功後重載儀器選單
bindRegisterForm("add-instrument-form", "add-instrument-msg", "/api/instruments", {}, () => loadInstruments());

// 表單 reset 後組別會跳回第一個選項，儀器選單需跟著重新過濾
function resyncRegCascade(groupId, instId) {
  fillInstrumentSelect(instId, document.getElementById(groupId).value, false);
}

// 2) 新增檢驗項目：可關聯試劑（reagent_item_map）；成功後刷新各頁選單
bindRegisterForm("add-item-form", "add-item-msg", "/api/items",
  {
    numbers: ["sort_order"],
    transform(payload) {
      payload.reagent_ids = checkedLinks("reg-item-reagents");
    },
  },
  () => {
    resyncRegCascade("reg-item-group", "reg-item-instrument");
    loadReagentItemOptions();
    loadRQCItemOptions();
    reloadLinkOptions("all");
  });

// 3) 新增試劑：勾選的檢體代碼 → specimen_type_codes
bindRegisterForm(
  "add-reagent-form",
  "add-reagent-msg",
  "/api/reagents",
  {
    checkboxes: ["in_stock", "parallel_test_done", "same_lot_as_previous"],
    transform(payload) {
      payload.specimen_type_codes = checkedLinks("reg-reagent-specimens");
      payload.item_ids = checkedLinks("reg-reagent-items");        // reagent_item_map
      payload.reagent_qc_ids = checkedLinks("reg-reagent-qcs");    // qc_reagent_map
    },
  },
  () => {
    resyncRegCascade("reg-reagent-group", "reg-reagent-instrument");
    loadReagentItemOptions();
    reloadLinkOptions("all");
  }
);

// 4) 新增品管液
// 設定檔只含識別資訊與試劑關聯；批號相關欄位在「新批號輸入」分頁
bindRegisterForm("add-reagent-qc-form", "add-reagent-qc-msg", "/api/reagent-qc", {
  checkboxes: ["in_use"],
  transform(payload) {
    payload.reagent_ids = checkedLinks("reg-rqc-reagents"); // qc_reagent_map
  },
}, () => {
  resyncRegCascade("reg-rqc-group", "reg-rqc-instrument");
  loadRQCItemOptions();
  reloadLinkOptions("all");
});

// 5) 新增檢體類別：成功後刷新選項與清單
bindRegisterForm("add-specimen-form", "add-specimen-msg", "/api/specimen-types", {}, () => {
  loadSpecimenOptions();
  loadSpecimenTable();
});

// ---------- 主檔關聯圖（互動式 ER）----------
let erInited = false;
let ER = null;          // 後端回傳的關聯資料
let erSelected = null;  // 目前選取的節點 key

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function loadER() {
  const sn = document.getElementById("er-instrument").value;
  const cols = document.getElementById("er-columns");
  const stats = document.getElementById("er-stats");
  const detail = document.getElementById("er-detail");
  if (!sn) {
    cols.innerHTML = `<div class="er-empty">請先選擇儀器</div>`;
    return;
  }
  try {
    ER = await api(`/api/er-graph?instrument_serial_number=${encodeURIComponent(sn)}`);
  } catch (e) {
    cols.innerHTML = `<div class="er-empty">載入失敗：${esc(e.message)}</div>`;
    return;
  }

  const c = ER.counts;
  stats.innerHTML = [
    `品管液 ${c.reagent_qcs}`,
    `試劑 ${c.reagents}`,
    `檢驗項目 ${c.items}`,
    `品管↔試劑 ${c.qc_reagent_links} 條關聯`,
    `試劑↔項目 ${c.reagent_item_links} 條關聯`,
  ].map((t) => `<span class="er-chip">${t}</span>`).join("");

  const i = ER.instrument;
  const instCard = `
    <div class="er-node t-inst" data-key="inst:${esc(i.serial_number)}">
      <div class="er-title">${esc(i.instrument_name)}</div>
      <div class="er-sub">S/N ${esc(i.serial_number)}<br>${esc(i.lab_group)} · ${esc(i.machine_role)}</div>
    </div>`;

  const qcCards = ER.reagent_qcs.length
    ? ER.reagent_qcs.map((q) => `
      <div class="er-node t-qc" data-key="qc:${esc(q.reagent_qc_id)}">
        <div class="er-title">${esc(q.test_item)} · ${esc(q.qc_level)}</div>
        <div class="er-sub">批號 ${esc(q.qc_lot_number)}</div>
        <div>
          ${q.specimen_code ? `<span class="er-tag">${esc(q.specimen_code)}</span>` : ""}
          <span class="er-tag ${q.parallel_test_done ? "ok" : "warn"}">${q.parallel_test_done ? "已平測" : "未平測"}</span>
          ${q.in_use ? `<span class="er-tag ok">使用中</span>` : ""}
        </div>
      </div>`).join("")
    : `<div class="er-empty">尚無品管液</div>`;

  const reagentCards = ER.reagents.length
    ? ER.reagents.map((r) => `
      <div class="er-node t-reagent" data-key="reagent:${esc(r.reagent_id)}">
        <div class="er-title">${esc(r.reagent_name)}</div>
        <div class="er-sub">批號 ${esc(r.lot_number)} ｜ 項目 ${esc(r.test_item)}</div>
        <div>
          ${(r.specimen_codes || []).map((s) => `<span class="er-tag">${esc(s)}</span>`).join("")}
          <span class="er-tag ${r.in_stock ? "ok" : "warn"}">${r.in_stock ? "已入庫" : "未入庫"}</span>
          <span class="er-tag ${r.parallel_test_done ? "ok" : "warn"}">${r.parallel_test_done ? "已平測" : "未平測"}</span>
        </div>
      </div>`).join("")
    : `<div class="er-empty">尚無試劑</div>`;

  const itemCards = ER.items.length
    ? ER.items.map((it) => `
      <div class="er-node t-item" data-key="item:${esc(it.item_id)}">
        <div class="er-title">${esc(it.item_code)}</div>
        <div class="er-sub">${esc(it.item_name || "")}${it.unit ? " ｜ " + esc(it.unit) : ""}</div>
      </div>`).join("")
    : `<div class="er-empty">尚無檢驗項目</div>`;

  cols.innerHTML = `
    <div class="er-col t-inst"><div class="er-col-head">儀器</div>${instCard}</div>
    <div class="er-col t-qc"><div class="er-col-head">品管液 (QC)</div>${qcCards}</div>
    <div class="er-col t-reagent"><div class="er-col-head">試劑</div>${reagentCards}</div>
    <div class="er-col t-item"><div class="er-col-head">檢驗項目</div>${itemCards}</div>`;

  detail.innerHTML = `<div class="placeholder">點擊卡片查看詳細資料與關聯</div>`;
  erSelected = null;
  document.getElementById("er-canvas").classList.remove("has-selection");

  cols.querySelectorAll(".er-node").forEach((n) => {
    n.addEventListener("click", () => selectERNode(n.dataset.key));
  });

  requestAnimationFrame(drawEREdges);
}

// 依中介表關聯畫出節點之間的連線
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
    return {
      x: (side === "right" ? r.right : r.left) - box.left + canvas.scrollLeft,
      y: r.top + r.height / 2 - box.top + canvas.scrollTop,
    };
  };

  const css = getComputedStyle(document.documentElement);
  const colorQC = css.getPropertyValue("--er-qc").trim();
  const colorReagent = css.getPropertyValue("--er-reagent").trim();
  const colorItem = css.getPropertyValue("--er-item").trim();

  const edges = [];
  // 儀器 → 品管液
  ER.reagent_qcs.forEach((q) => {
    edges.push({ from: `inst:${ER.instrument.serial_number}`, to: `qc:${q.reagent_qc_id}`, color: colorQC });
  });
  // 品管液 → 試劑
  ER.edges.qc_reagent.forEach((e) => {
    edges.push({ from: `qc:${e.reagent_qc_id}`, to: `reagent:${e.reagent_id}`, color: colorReagent });
  });
  // 試劑 → 檢驗項目
  ER.edges.reagent_item.forEach((e) => {
    edges.push({ from: `reagent:${e.reagent_id}`, to: `item:${e.item_id}`, color: colorItem });
  });

  svg.innerHTML = edges
    .map((e) => {
      const a = anchor(e.from, "right");
      const b = anchor(e.to, "left");
      if (!a || !b) return "";
      const dx = Math.max(24, (b.x - a.x) / 2);
      const d = `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
      return `<path class="er-edge" d="${d}" stroke="${e.color}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"></path>`;
    })
    .join("");
  ER._edgeList = edges;
  if (erSelected) applyERHighlight(erSelected);
}

// 由選取節點沿關聯向兩側展開，找出所有相連節點
function erConnectedKeys(key) {
  const keys = new Set([key]);
  const edges = ER._edgeList || [];
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
  const keys = erConnectedKeys(key);
  canvas.classList.add("has-selection");
  canvas.querySelectorAll(".er-node").forEach((n) => {
    n.classList.toggle("hl", keys.has(n.dataset.key));
    n.classList.toggle("root", n.dataset.key === key);
  });
  canvas.querySelectorAll(".er-edge").forEach((p) => {
    p.classList.toggle("hl", keys.has(p.dataset.from) && keys.has(p.dataset.to));
  });
}

function clearERSelection() {
  const canvas = document.getElementById("er-canvas");
  canvas.classList.remove("has-selection");
  canvas.querySelectorAll(".er-node").forEach((n) => n.classList.remove("hl", "root"));
  canvas.querySelectorAll(".er-edge").forEach((p) => p.classList.remove("hl"));
  erSelected = null;
  document.getElementById("er-detail").innerHTML =
    `<div class="placeholder">點擊卡片查看詳細資料與關聯</div>`;
}

function selectERNode(key) {
  if (erSelected === key) { clearERSelection(); return; }
  erSelected = key;
  applyERHighlight(key);
  renderERDetail(key);
  // 面板收合時點擊卡片，自動展開以顯示明細
  if (document.getElementById("er-layout").classList.contains("detail-collapsed")) {
    toggleERDetail(false);
  }
}

// 選取節點的明細與其直接關聯清單
function renderERDetail(key) {
  const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const kv = (k, v) => `<div class="er-kv">${k}：<b>${esc(v ?? "-")}</b></div>`;
  let html = "";

  if (type === "inst") {
    const i = ER.instrument;
    html = `<h4>🖥️ ${esc(i.instrument_name)}</h4>${kv("S/N", i.serial_number)}
      ${kv("組別", i.lab_group)}${kv("角色", i.machine_role)}
      ${kv("關聯", `品管液 ${ER.counts.reagent_qcs} ｜ 試劑 ${ER.counts.reagents} ｜ 項目 ${ER.counts.items}`)}`;
  } else if (type === "qc") {
    const q = ER.reagent_qcs.find((x) => x.reagent_qc_id === id);
    const linked = ER.edges.qc_reagent.filter((e) => e.reagent_qc_id === id)
      .map((e) => ER.reagents.find((r) => r.reagent_id === e.reagent_id)?.reagent_name)
      .filter(Boolean);
    html = `<h4>🧫 品管液：${esc(q.test_item)} · ${esc(q.qc_level)}</h4>
      ${kv("批號", q.qc_lot_number)}${kv("檢體類別", q.specimen_code ? `${q.specimen_code}（${q.specimen_name}）` : "-")}
      ${kv("原廠 Mean / SD", `${q.manufacturer_mean ?? "-"} / ${q.manufacturer_sd ?? "-"}`)}
      ${kv("平測後 Mean / SD", `${q.new_standard_mean ?? "-"} / ${q.new_standard_sd ?? "-"}`)}
      ${kv("平行測試", q.parallel_test_done ? "已完成" : "未完成")}
      ${kv("管理的試劑", linked.length ? linked.join("、") : "（尚無關聯）")}`;
  } else if (type === "reagent") {
    const r = ER.reagents.find((x) => x.reagent_id === id);
    const items = ER.edges.reagent_item.filter((e) => e.reagent_id === id)
      .map((e) => ER.items.find((it) => it.item_id === e.item_id)?.item_code)
      .filter(Boolean);
    const qcs = ER.edges.qc_reagent.filter((e) => e.reagent_id === id)
      .map((e) => {
        const q = ER.reagent_qcs.find((x) => x.reagent_qc_id === e.reagent_qc_id);
        return q ? `${q.test_item} ${q.qc_level}（${q.qc_lot_number}）` : null;
      }).filter(Boolean);
    html = `<h4>🧪 試劑：${esc(r.reagent_name)}</h4>
      ${kv("批號", r.lot_number)}${kv("對應項目欄位", r.test_item)}
      ${kv("可操作檢體", (r.specimen_codes || []).join("、") || "-")}
      ${kv("入庫 / 平測", `${r.in_stock ? "已入庫" : "未入庫"} / ${r.parallel_test_done ? "已平測" : "未平測"}`)}
      ${kv("檢驗項目", items.length ? items.join("、") : "（尚無關聯）")}
      ${kv("使用的品管液", qcs.length ? qcs.join("、") : "（尚無關聯）")}`;
  } else if (type === "item") {
    const it = ER.items.find((x) => x.item_id === id);
    const reagents = ER.edges.reagent_item.filter((e) => e.item_id === id)
      .map((e) => ER.reagents.find((r) => r.reagent_id === e.reagent_id)?.reagent_name)
      .filter(Boolean);
    html = `<h4>🔬 檢驗項目：${esc(it.item_code)}</h4>
      ${kv("全名", it.item_name)}${kv("單位", it.unit)}
      ${kv("由哪些試劑產生", reagents.length ? reagents.join("、") : "（尚無關聯）")}`;
  }
  document.getElementById("er-detail").innerHTML = html;
}

// 詳細資料面板收合（向右滑出動畫）。
// 欄寬會隨面板開合改變（卡片文字換行、高度變動），故動畫期間持續重算連線。
function toggleERDetail(collapsed) {
  const layout = document.getElementById("er-layout");
  layout.classList.toggle("detail-collapsed", collapsed);
  const until = performance.now() + 360;
  const tick = () => {
    if (ER) drawEREdges();
    if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
document.getElementById("er-detail-toggle").addEventListener("click", () => toggleERDetail(true));
document.getElementById("er-detail-open").addEventListener("click", () => toggleERDetail(false));

document.getElementById("er-group").addEventListener("change", (e) => {
  fillInstrumentSelect("er-instrument", e.target.value, false);
  loadER();
});
document.getElementById("er-instrument").addEventListener("change", loadER);
document.getElementById("er-refresh").addEventListener("click", loadER);
document.getElementById("er-reset").addEventListener("click", clearERSelection);

// 畫布尺寸只要改變（面板開合、側欄收合、視窗縮放）就重算連線座標
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (ER) drawEREdges(); })
    .observe(document.getElementById("er-canvas"));
} else {
  window.addEventListener("resize", () => { if (ER) drawEREdges(); });
}

function openER() {
  if (!erInited) { erInited = true; loadER(); }
  else requestAnimationFrame(drawEREdges); // 切回分頁時重算座標
}

// ---------- 管理頁（修改 / 移除 項目・試劑・品管液）----------
// 各管理頁設定：清單 API、資源 API、表格欄位、編輯欄位
const MANAGE = {
  "mg-item": {
    listPath: "/api/items",
    resPath: (id) => `/api/items/${id}`,
    pk: "item_id",
    label: "檢驗項目",
    nameOf: (r) => r.item_code,
    cells: (r) => [r.item_code, r.item_name ?? "", r.unit ?? "", r.sort_order ?? 0],
    fields: [
      { name: "item_code", label: "項目代碼*", type: "text", required: true },
      { name: "item_name", label: "項目全名", type: "text" },
      { name: "unit", label: "單位", type: "text" },
      { name: "sort_order", label: "排序", type: "number" },
      { name: "reagent_ids", label: "由哪些試劑產生（reagent_item_map）", type: "links", kind: "reagents" },
    ],
  },
  "mg-reagent": {
    listPath: "/api/reagents",
    resPath: (id) => `/api/reagents/${id}`,
    pk: "reagent_id",
    label: "試劑",
    nameOf: (r) => r.reagent_name,
    cells: (r) => [
      r.reagent_name, r.lot_number, r.test_item,
      (r.specimen_type_codes || []).join("、") || "-",
      pill(r.in_stock, "已入庫", "未入庫"),
      pill(r.parallel_test_done, "已平測", "未平測"),
      r.expiry_date ?? "-",
    ],
    fields: [
      { name: "reagent_name", label: "試劑名稱*", type: "text", required: true },
      { name: "lot_number", label: "試劑批號*", type: "text", required: true },
      { name: "test_item", label: "對應檢驗項目*", type: "text", required: true },
      { name: "manufacturer", label: "廠商", type: "text" },
      { name: "expiry_date", label: "效期", type: "date" },
      { name: "previous_lot_number", label: "上一個批號", type: "text" },
      { name: "in_stock_date", label: "入庫日期", type: "date" },
      { name: "parallel_test_date", label: "平測完成日期", type: "date" },
      { name: "in_stock", label: "已入庫", type: "checkbox" },
      { name: "parallel_test_done", label: "已完成平測", type: "checkbox" },
      { name: "same_lot_as_previous", label: "與上一批同批號", type: "checkbox" },
      { name: "specimen_type_codes", label: "可操作檢體類別", type: "specimens" },
      { name: "item_ids", label: "負責的檢驗項目（reagent_item_map）", type: "links", kind: "items" },
      { name: "reagent_qc_ids", label: "管理此試劑的品管液（qc_reagent_map）", type: "links", kind: "qcs" },
      { name: "remark", label: "備註", type: "text", full: true },
    ],
  },
  "mg-rqc": {
    listPath: "/api/reagent-qc",
    resPath: (id) => `/api/reagent-qc/${id}`,
    pk: "reagent_qc_id",
    label: "品管液",
    nameOf: (r) => `${r.test_item} ${r.qc_level}`,
    cells: (r) => [
      r.test_item, r.qc_level, r.qc_lot_number,
      r.specimen_type_code ?? "-",
      `${r.new_standard_mean ?? r.manufacturer_mean ?? "-"} / ${r.new_standard_sd ?? r.manufacturer_sd ?? "-"}`,
      pill(r.parallel_test_done, "已平測", "未平測"),
      pill(r.in_use, "使用中", "停用中"),
    ],
    fields: [
      { name: "test_item", label: "檢驗項目*", type: "text", required: true },
      { name: "test_item_full_name", label: "項目全名", type: "text" },
      { name: "qc_level", label: "濃度 (Level)*", type: "text", required: true },
      { name: "qc_lot_number", label: "品管液批號*", type: "text", required: true },
      { name: "specimen_type_code", label: "檢體類別", type: "specimen-one" },
      { name: "unit", label: "單位", type: "text" },
      { name: "manufacturer_mean", label: "原廠均值", type: "number" },
      { name: "manufacturer_sd", label: "原廠 SD", type: "number" },
      { name: "new_standard_mean", label: "平測後新均值", type: "number" },
      { name: "new_standard_sd", label: "平測後新 SD", type: "number" },
      { name: "parallel_test_date", label: "平測完成日期", type: "date" },
      { name: "parallel_test_done", label: "已完成平行測試", type: "checkbox" },
      { name: "in_use", label: "目前使用中", type: "checkbox" },
      { name: "reagent_ids", label: "管理哪些試劑（qc_reagent_map）", type: "links", kind: "reagents" },
      { name: "remark", label: "備註", type: "text", full: true },
    ],
  },
};

const pill = (on, yes, no) =>
  `<span class="state-pill ${on ? "on" : "off"}">${on ? yes : no}</span>`;

let SPECIMEN_TYPES = [];
let mgCurrent = null; // { view, row }

// 載入某管理頁的清單（依儀器過濾）
async function loadManage(view) {
  const cfg = MANAGE[view];
  const sn = document.getElementById(`${view}-instrument`).value;
  const tbody = document.querySelector(`#${view}-table tbody`);
  const cols = cfg.cells({ specimen_type_codes: [] }).length + 2;
  if (!sn) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">請先選擇儀器</td></tr>`;
    return;
  }
  tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">載入中…</td></tr>`;
  try {
    // include_inactive：管理頁需列出已停用者，才能重新啟用
    const rows = await api(
      `${cfg.listPath}?instrument_serial_number=${encodeURIComponent(sn)}&include_inactive=true`
    );
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">此儀器尚無${cfg.label}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const id = r[cfg.pk];
        return `<tr>
          ${cfg.cells(r).map((c) => `<td>${c}</td>`).join("")}
          <td>${pill(r.active !== false, "啟用", "停用")}</td>
          <td><div class="row-actions">
            <button class="btn-xs" data-act="edit" data-id="${esc(id)}">編輯</button>
            <button class="btn-xs" data-act="toggle" data-id="${esc(id)}">${r.active !== false ? "停用" : "啟用"}</button>
            <button class="btn-xs danger" data-act="del" data-id="${esc(id)}">刪除</button>
          </div></td>
        </tr>`;
      })
      .join("");
    // 綁定列操作
    tbody.querySelectorAll("button[data-act]").forEach((b) => {
      const row = rows.find((r) => String(r[cfg.pk]) === b.dataset.id);
      b.addEventListener("click", () => {
        if (b.dataset.act === "edit") openEditModal(view, row);
        if (b.dataset.act === "toggle") toggleActive(view, row);
        if (b.dataset.act === "del") deleteRow(view, row);
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">載入失敗：${esc(e.message)}</td></tr>`;
  }
}

function mgMsg(view, text, cls = "") {
  const el = document.getElementById(`${view}-msg`);
  el.className = "add-msg " + cls;
  el.textContent = text;
}

// 取出後端錯誤訊息中的 detail
function errText(err) {
  try { return JSON.parse(err.message).detail || err.message; } catch { return err.message; }
}

// 停用 / 啟用（保留歷史資料的安全作法）
async function toggleActive(view, row) {
  const cfg = MANAGE[view];
  const next = row.active === false;
  try {
    await api(cfg.resPath(row[cfg.pk]), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: next }),
    });
    mgMsg(view, `✅ 已${next ? "啟用" : "停用"}「${cfg.nameOf(row)}」`, "ok");
    loadManage(view);
  } catch (e) {
    mgMsg(view, "❌ 失敗：" + errText(e), "err");
  }
}

async function deleteRow(view, row) {
  const cfg = MANAGE[view];
  if (!confirm(`確定要刪除${cfg.label}「${cfg.nameOf(row)}」嗎？此動作無法復原。\n\n若此筆已被引用，建議改用「停用」。`)) return;
  try {
    await api(cfg.resPath(row[cfg.pk]), { method: "DELETE" });
    mgMsg(view, `✅ 已刪除「${cfg.nameOf(row)}」`, "ok");
    loadManage(view);
  } catch (e) {
    mgMsg(view, "❌ " + errText(e), "err");
  }
}

// ---- 編輯對話框 ----
const editModal = document.getElementById("edit-modal");

async function openEditModal(view, row) {
  const cfg = MANAGE[view];
  mgCurrent = { view, row };
  document.getElementById("edit-modal-title").textContent = `編輯${cfg.label}：${cfg.nameOf(row)}`;
  document.getElementById("edit-modal-msg").textContent = "";

  document.getElementById("edit-form").innerHTML = cfg.fields
    .map((f) => {
      const v = row[f.name];
      if (f.type === "checkbox") {
        return `<label class="check-label"><input type="checkbox" name="${f.name}" ${v ? "checked" : ""} />${f.label}</label>`;
      }
      if (f.type === "links") {
        // 候選清單需向後端取，先放容器，稍後以 msRender 填入並預先勾選
        return `<fieldset class="full check-group"><legend>${esc(f.label)}</legend>
                  <div id="edit-link-${esc(f.name)}"><span class="check-empty">載入中…</span></div>
                </fieldset>`;
      }
      if (f.type === "specimens") {
        return `<fieldset class="full check-group"><legend>${esc(f.label)}（可複選）</legend>
                  <div id="edit-link-${esc(f.name)}"></div>
                </fieldset>`;
      }
      if (f.type === "specimen-one") {
        return `<label>${f.label}<select name="${f.name}"><option value="">（不指定）</option>${
          SPECIMEN_TYPES.map((s) => `<option value="${esc(s.code)}" ${v === s.code ? "selected" : ""}>${esc(s.code)}（${esc(s.name)}）</option>`).join("")
        }</select></label>`;
      }
      const val = v == null ? "" : String(v);
      const step = f.type === "number" ? ' step="any"' : "";
      return `<label class="${f.full ? "full" : ""}">${f.label}<input type="${f.type}" name="${f.name}" value="${esc(val)}"${step} ${f.required ? "required" : ""} /></label>`;
    })
    .join("");
  editModal.classList.add("open");

  // 檢體類別（本地清單，直接渲染並勾選現有值）
  const specField = cfg.fields.find((f) => f.type === "specimens");
  if (specField) {
    msRender(
      `edit-link-${specField.name}`,
      SPECIMEN_TYPES.map((s) => ({ value: s.code, label: `${s.code}（${s.name}）` })),
      "尚無檢體類別",
      row.specimen_type_codes || []
    );
  }

  // 關聯欄位：依該筆所屬儀器取候選清單，並勾選目前已關聯者
  const sn = row.instrument_serial_number;
  for (const f of cfg.fields.filter((x) => x.type === "links")) {
    const cid = `edit-link-${f.name}`;
    try {
      const opts = await fetchLinkOptions(f.kind, sn);
      msRender(cid, opts, LINK_KINDS[f.kind].empty, row[f.name] || []);
    } catch (e) {
      const el = document.getElementById(cid);
      if (el) { el.classList.remove("ms"); el.innerHTML = `<span class="check-empty">載入失敗：${esc(e.message)}</span>`; }
    }
  }
}

function closeEditModal() {
  editModal.classList.remove("open");
  mgCurrent = null;
}
document.getElementById("edit-modal-close").addEventListener("click", closeEditModal);
document.getElementById("edit-modal-cancel").addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => { if (e.target === editModal) closeEditModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && editModal.classList.contains("open")) closeEditModal(); });

document.getElementById("edit-modal-save").addEventListener("click", async () => {
  if (!mgCurrent) return;
  const { view, row } = mgCurrent;
  const cfg = MANAGE[view];
  const form = document.getElementById("edit-form");
  const msg = document.getElementById("edit-modal-msg");

  if (!form.reportValidity()) return;

  const payload = {};
  cfg.fields.forEach((f) => {
    if (f.type === "checkbox") {
      payload[f.name] = form.querySelector(`[name=${f.name}]`).checked;
    } else if (f.type === "specimens" || f.type === "links") {
      // 整組覆寫；候選清單載入失敗時（無 .ms 容器）略過該欄以免誤清空關聯
      const box = document.getElementById(`edit-link-${f.name}`);
      if (box && box.classList.contains("ms")) payload[f.name] = checkedLinks(`edit-link-${f.name}`);
    } else {
      const el = form.querySelector(`[name=${f.name}]`);
      const v = el.value.trim();
      // 空字串代表清空該欄位；數字欄位轉型
      payload[f.name] = v === "" ? null : f.type === "number" ? parseFloat(v) : v;
    }
  });

  msg.className = "add-msg";
  msg.textContent = "儲存中…";
  try {
    await api(cfg.resPath(row[cfg.pk]), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    closeEditModal();
    mgMsg(view, `✅ 已更新「${cfg.nameOf(row)}」`, "ok");
    loadManage(view);
  } catch (e) {
    msg.className = "add-msg err";
    msg.textContent = "❌ " + errText(e);
  }
});

// 三個管理頁的組別 → 儀器連動與查詢
Object.keys(MANAGE).forEach((view) => {
  document.getElementById(`${view}-group`).addEventListener("change", (e) => {
    fillInstrumentSelect(`${view}-instrument`, e.target.value, false);
    loadManage(view);
  });
  document.getElementById(`${view}-instrument`).addEventListener("change", () => loadManage(view));
  document.getElementById(`${view}-refresh`).addEventListener("click", () => loadManage(view));
});

function openManage(view) {
  loadManage(view);
}

// ---------- 新增品管液：設定檔 / 新批號 兩種模式 ----------
const RQC_HINTS = {
  profile:
    '建立某台儀器上「某檢驗項目 · 某濃度 · 某檢體」的品管液設定檔。設定檔 ID 固定，' +
    '試劑關聯（<code>qc_reagent_map</code>）掛在此設定檔上；日後<strong>換批號請用「新批號輸入」</strong>，' +
    "才不會產生重複設定檔導致試劑抓錯。",
  lot:
    "選定組別 / 儀器 / 檢體類別 / 檢驗項目後，系統會自動帶出目前使用中的批號與效期，" +
    "填入新批號即可換批。<strong>設定檔 ID 不變</strong>，試劑關聯與歷史品管紀錄都不受影響，" +
    "舊批號會保留為歷史批號。",
};

document.querySelectorAll(".mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll(".mode-tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.getElementById("rqc-mode-lot").classList.toggle("active", mode === "lot");
    document.getElementById("add-reagent-qc-form").classList.toggle("active", mode === "profile");
    document.getElementById("rqc-json-panel").classList.toggle("active", mode === "profile");
    document.getElementById("rqc-mode-hint").innerHTML = RQC_HINTS[mode];
    if (mode === "lot") loadLotTestItems();
  });
});

// 新批號模式：依儀器 + 檢體帶出有設定檔的檢驗項目
async function loadLotTestItems() {
  const sn = document.getElementById("lot-instrument").value;
  const spec = document.getElementById("lot-specimen").value;
  const sel = document.getElementById("lot-test-item");
  if (!sn) {
    sel.innerHTML = `<option value="" disabled selected>（請先選擇儀器）</option>`;
    document.getElementById("lot-levels").innerHTML = "";
    return;
  }
  try {
    const params = new URLSearchParams({ instrument_serial_number: sn });
    if (spec) params.set("specimen_type_code", spec);
    const rows = await api("/api/reagent-qc?" + params.toString());
    const items = [...new Set(rows.map((r) => r.test_item))].sort();
    sel.innerHTML = items.length
      ? items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")
      : `<option value="" disabled selected>（此條件下尚無品管液設定檔）</option>`;
  } catch {
    sel.innerHTML = `<option value="" disabled selected>（載入失敗）</option>`;
  }
  loadLotLevels();
}

// 帶出該項目各濃度目前使用中的批號，並提供新批號輸入欄
async function loadLotLevels() {
  const box = document.getElementById("lot-levels");
  const sn = document.getElementById("lot-instrument").value;
  const spec = document.getElementById("lot-specimen").value;
  const item = document.getElementById("lot-test-item").value;
  if (!sn || !item) { box.innerHTML = ""; return; }

  const params = new URLSearchParams({ instrument_serial_number: sn, test_item: item });
  if (spec) params.set("specimen_type_code", spec);
  let rows;
  try {
    rows = await api("/api/reagent-qc/current?" + params.toString());
  } catch (e) {
    box.innerHTML = `<div class="empty">載入失敗：${esc(e.message)}</div>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<div class="empty">此條件下查無品管液設定檔，請先於「品管液設定檔」建立。</div>`;
    return;
  }

  const today = todayStr();
  box.innerHTML = rows
    .map((r) => {
      // 效期預警：已過期 / 30 天內到期
      let expCls = "";
      if (r.expiry_date) {
        const days = (new Date(r.expiry_date) - new Date(today)) / 86400000;
        expCls = days < 0 ? "lot-expired" : days <= 30 ? "lot-expiring" : "";
      }
      return `
      <div class="lot-card" data-qc-id="${esc(r.reagent_qc_id)}">
        <div class="lot-card-head">
          <h4>${esc(r.test_item)} · ${esc(r.qc_level)}</h4>
          ${r.specimen_type_code ? `<span class="er-tag">${esc(r.specimen_type_code)}</span>` : ""}
          <div class="lot-current">
            <span>目前批號 <b>${esc(r.qc_lot_number ?? "-")}</b></span>
            <span class="${expCls}">效期 <b>${esc(r.expiry_date ?? "-")}</b></span>
            <span>Mean/SD <b>${r.new_standard_mean ?? r.manufacturer_mean ?? "-"} / ${r.new_standard_sd ?? r.manufacturer_sd ?? "-"}</b></span>
            <span>平測 <b>${r.parallel_test_done ? "已完成" : "未完成"}</b></span>
          </div>
        </div>
        <div class="lot-fields">
          <label>新批號<input data-f="qc_lot_number" placeholder="留空則不更換此濃度" /></label>
          <label>效期<input type="date" data-f="expiry_date" /></label>
          <label>啟用日<input type="date" data-f="effective_from" value="${today}" /></label>
          <label class="check-label"><input type="checkbox" data-f="parallel_test_done" />已完成平行測試</label>
          <label>原廠均值<input type="number" step="any" data-f="manufacturer_mean" /></label>
          <label>原廠 SD<input type="number" step="any" data-f="manufacturer_sd" /></label>
          <label>平測後新均值<input type="number" step="any" data-f="new_standard_mean" /></label>
          <label>平測後新 SD<input type="number" step="any" data-f="new_standard_sd" /></label>
        </div>
      </div>`;
    })
    .join("");
}

document.getElementById("lot-group").addEventListener("change", (e) => {
  fillInstrumentSelect("lot-instrument", e.target.value, false);
  loadLotTestItems();
});
document.getElementById("lot-instrument").addEventListener("change", loadLotTestItems);
document.getElementById("lot-specimen").addEventListener("change", loadLotTestItems);
document.getElementById("lot-test-item").addEventListener("change", loadLotLevels);

// 送出：只送有填新批號的濃度
document.getElementById("lot-submit").addEventListener("click", async () => {
  const msg = document.getElementById("lot-msg");
  const cards = [...document.querySelectorAll("#lot-levels .lot-card")];
  const jobs = [];
  cards.forEach((card) => {
    const val = (f) => card.querySelector(`[data-f="${f}"]`);
    const lot = val("qc_lot_number").value.trim();
    if (!lot) return; // 留空表示此濃度不換批
    const num = (f) => {
      const v = val(f).value.trim();
      return v === "" ? null : parseFloat(v);
    };
    const str = (f) => val(f).value.trim() || null;
    jobs.push({
      id: card.dataset.qcId,
      body: {
        qc_lot_number: lot,
        expiry_date: str("expiry_date"),
        effective_from: str("effective_from"),
        parallel_test_done: val("parallel_test_done").checked,
        manufacturer_mean: num("manufacturer_mean"),
        manufacturer_sd: num("manufacturer_sd"),
        new_standard_mean: num("new_standard_mean"),
        new_standard_sd: num("new_standard_sd"),
      },
    });
  });

  if (!jobs.length) {
    msg.className = "add-msg err";
    msg.textContent = "❌ 請至少填入一個濃度的新批號";
    return;
  }
  msg.className = "add-msg";
  msg.textContent = `登錄中…（${jobs.length} 個濃度）`;
  let done = 0;
  for (const [i, j] of jobs.entries()) {
    try {
      await api(`/api/reagent-qc/${encodeURIComponent(j.id)}/lots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(j.body),
      });
      done++;
    } catch (e) {
      let text = e.message;
      try { text = JSON.parse(e.message).detail || text; } catch {}
      msg.className = "add-msg err";
      msg.textContent = `❌ 已完成 ${done} 筆，第 ${i + 1} 筆失敗：${text}`;
      loadLotLevels();
      return;
    }
  }
  msg.className = "add-msg ok";
  msg.textContent = `✅ 已登錄 ${done} 個濃度的新批號（設定檔 ID 不變，試劑關聯不受影響）`;
  loadLotLevels();
});

// ---------- JSON 匯入 ----------
// 各頁面的 API 路徑、欄位格式（[型別, 是否必填]）與模板；模板同時作為輸入框提示
const JSON_IMPORTS = {
  inst: {
    path: "/api/instruments",
    schema: {
      serial_number: ["string", true],
      instrument_name: ["string", true],
      group_name: ["string", true],
      machine_role: ["string", false],
    },
    template: `{
  "serial_number": "43056",
  "instrument_name": "Sysmex XN-3000-A",
  "group_name": "血液組",
  "machine_role": "主機"
}`,
    onSuccess: () => loadInstruments(),
  },
  item: {
    path: "/api/items",
    schema: {
      instrument_serial_number: ["string", true],
      item_code: ["string", true],
      item_name: ["string", false],
      unit: ["string", false],
      sort_order: ["number", false],
      reagent_ids: ["string[]", false],
    },
    template: `[
  { "instrument_serial_number": "43056", "item_code": "RBC", "item_name": "Red Blood Cell Count", "unit": "10^6/uL", "sort_order": 1 },
  { "instrument_serial_number": "43056", "item_code": "HGB", "item_name": "Hemoglobin", "unit": "g/dL", "sort_order": 2 }
]`,
    onSuccess: () => { loadReagentItemOptions(); loadRQCItemOptions(); },
  },
  reagent: {
    path: "/api/reagents",
    schema: {
      instrument_serial_number: ["string", true],
      test_item: ["string", true],
      reagent_name: ["string", true],
      lot_number: ["string", true],
      manufacturer: ["string", false],
      in_stock: ["boolean", false],
      in_stock_date: ["string", false],
      parallel_test_done: ["boolean", false],
      parallel_test_date: ["string", false],
      same_lot_as_previous: ["boolean", false],
      previous_lot_number: ["string", false],
      expiry_date: ["string", false],
      specimen_type_codes: ["string[]", false],
      item_ids: ["string[]", false],
      reagent_qc_ids: ["string[]", false],
      remark: ["string", false],
    },
    template: `{
  "instrument_serial_number": "43056",
  "test_item": "m-ALB",
  "reagent_name": "Tina-quant Albumin Gen.2",
  "lot_number": "LOT-2026A",
  "manufacturer": "Roche",
  "in_stock": true,
  "in_stock_date": "2026-07-01",
  "parallel_test_done": false,
  "same_lot_as_previous": false,
  "expiry_date": "2027-06-30",
  "specimen_type_codes": ["U", "CSF"],
  "remark": ""
}`,
  },
  // 品管液「設定檔」：只有識別資訊與試劑關聯，批號請走「新批號輸入」
  rqc: {
    path: "/api/reagent-qc",
    schema: {
      instrument_serial_number: ["string", true],
      specimen_type_code: ["string", false],
      test_item: ["string", true],
      test_item_full_name: ["string", false],
      qc_level: ["string", true],
      unit: ["string", false],
      in_use: ["boolean", false],
      reagent_ids: ["string[]", false],
      remark: ["string", false],
    },
    template: `[
  {
    "instrument_serial_number": "43056",
    "specimen_type_code": "B",
    "test_item": "Na",
    "test_item_full_name": "Sodium",
    "qc_level": "Level 1",
    "unit": "mmol/L",
    "in_use": true
  },
  {
    "instrument_serial_number": "43056",
    "specimen_type_code": "B",
    "test_item": "Na",
    "qc_level": "Level 2",
    "unit": "mmol/L"
  }
]`,
  },
  record: {
    path: "/api/records",
    schema: {
      instrument_name: ["string", true],
      instrument_serial_number: ["string", true],
      qc_date: ["string", true],
      qc_time: ["string", true],
      operator: ["string", false],
      test_item: ["string", true],
      test_item_full_name: ["string", false],
      qc_level: ["string", false],
      qc_lot_number: ["string", false],
      qc_result_value: ["number", true],
      unit: ["string", false],
      lot_mean: ["number", true],
      lot_standard_deviation: ["number", true],
      acceptable_range_lower: ["number", false],
      acceptable_range_upper: ["number", false],
      remark: ["string", false],
    },
    template: `{
  "instrument_name": "Sysmex XN-3000-A",
  "instrument_serial_number": "43056",
  "qc_date": "2026-07-20",
  "qc_time": "08:30:00",
  "operator": "MT001",
  "test_item": "WBC",
  "qc_level": "Level 1",
  "qc_lot_number": "QC-WBC-L1-202607",
  "qc_result_value": 5.21,
  "unit": "10^3/uL",
  "lot_mean": 5.00,
  "lot_standard_deviation": 0.25
}`,
    onSuccess: () => loadDashboard(),
  },
};

// 逐筆檢查欄位是否符合資料庫要求的格式，回傳錯誤訊息清單
function validateJsonRow(obj, schema, idx) {
  const errs = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [`第 ${idx} 筆不是 JSON 物件`];
  }
  for (const [field, [type, required]] of Object.entries(schema)) {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (required) errs.push(`第 ${idx} 筆缺少必填欄位「${field}」`);
      continue;
    }
    if (type === "string" && typeof v !== "string") errs.push(`第 ${idx} 筆「${field}」應為字串`);
    if (type === "number" && typeof v !== "number") errs.push(`第 ${idx} 筆「${field}」應為數字`);
    if (type === "boolean" && typeof v !== "boolean") errs.push(`第 ${idx} 筆「${field}」應為布林值 (true/false)`);
    if (type === "string[]" && (!Array.isArray(v) || v.some((x) => typeof x !== "string")))
      errs.push(`第 ${idx} 筆「${field}」應為字串陣列，如 ["U", "CSF"]`);
  }
  for (const k of Object.keys(obj)) {
    if (!(k in schema)) errs.push(`第 ${idx} 筆包含未知欄位「${k}」`);
  }
  return errs;
}

function bindJsonImport(key) {
  const cfg = JSON_IMPORTS[key];
  const ta = document.getElementById(`json-${key}`);
  const msg = document.getElementById(`json-${key}-msg`);
  ta.placeholder = cfg.template;

  // 複製 JSON 模板（剪貼簿不可用時直接填入輸入框）
  document.getElementById(`json-${key}-copy`).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cfg.template);
      msg.className = "add-msg ok";
      msg.textContent = "已複製模板到剪貼簿";
    } catch {
      ta.value = cfg.template;
      msg.className = "add-msg";
      msg.textContent = "剪貼簿不可用，已將模板填入輸入框";
    }
  });

  // 提交：解析 → 逐筆格式檢查 → 逐筆呼叫 API
  document.getElementById(`json-${key}-submit`).addEventListener("click", async () => {
    msg.className = "add-msg";
    let data;
    try {
      data = JSON.parse(ta.value);
    } catch (e) {
      msg.className = "add-msg err";
      msg.textContent = "❌ JSON 解析失敗：" + e.message;
      return;
    }
    const rows = Array.isArray(data) ? data : [data];
    if (!rows.length) {
      msg.className = "add-msg err";
      msg.textContent = "❌ 沒有可匯入的資料";
      return;
    }

    const errs = rows.flatMap((r, i) => validateJsonRow(r, cfg.schema, i + 1));
    if (errs.length) {
      msg.className = "add-msg err";
      msg.textContent = "❌ 格式檢查未通過：" + errs.slice(0, 3).join("；") + (errs.length > 3 ? ` …（共 ${errs.length} 項）` : "");
      return;
    }

    msg.textContent = `匯入中…（共 ${rows.length} 筆）`;
    let done = 0;
    for (const [i, row] of rows.entries()) {
      try {
        await api(cfg.path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        });
        done++;
      } catch (err) {
        let text = err.message;
        try { text = JSON.parse(err.message).detail || text; } catch {}
        msg.className = "add-msg err";
        msg.textContent = `❌ 已匯入 ${done} 筆，第 ${i + 1} 筆失敗：${text}`;
        if (cfg.onSuccess && done) cfg.onSuccess();
        return;
      }
    }
    msg.className = "add-msg ok";
    msg.textContent = `✅ 成功匯入 ${done} 筆`;
    ta.value = "";
    if (cfg.onSuccess) cfg.onSuccess();
  });
}
Object.keys(JSON_IMPORTS).forEach(bindJsonImport);

// ---------- 初始化 ----------
(async function init() {
  const t = todayStr();
  const ago = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  document.getElementById("dash-date").value = t;
  document.getElementById("rec-from").value = t;
  document.getElementById("rec-to").value = t;
  document.getElementById("lj-from").value = ago;
  document.getElementById("lj-to").value = t;
  document.getElementById("ai-from").value = ago;
  document.getElementById("ai-to").value = t;
  const qd = document.querySelector('#add-form [name=qc_date]');
  if (qd) qd.value = t;
  await loadInstruments();
  loadLabGroupOptions();
  loadSpecimenOptions();
  loadDashboard();
})();
