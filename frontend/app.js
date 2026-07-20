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
    if (t.dataset.view === "ai") openAI();
    if (t.dataset.view === "add-specimen") loadSpecimenTable();
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

// 新增試劑：第三層選單（儀器 → 該儀器的檢驗項目，來自 items 主檔）
async function loadReagentItemOptions() {
  const sn = document.getElementById("reg-reagent-instrument").value;
  const sel = document.getElementById("reg-reagent-item");
  if (!sn) {
    sel.innerHTML = `<option value="" disabled selected>（請先選擇儀器）</option>`;
    return;
  }
  try {
    const items = await api(`/api/items?instrument_serial_number=${encodeURIComponent(sn)}`);
    sel.innerHTML = items.length
      ? items
          .map((i) => `<option value="${i.item_code}">${i.item_code}${i.item_name ? "（" + i.item_name + "）" : ""}</option>`)
          .join("")
      : `<option value="" disabled selected>（此儀器尚無項目，請先新增檢驗項目）</option>`;
  } catch {
    sel.innerHTML = `<option value="" disabled selected>（項目載入失敗）</option>`;
  }
}
// 組別 / 儀器變動時重載第三層（組別 listener 先於此註冊，儀器清單已先更新）
document.getElementById("reg-reagent-group").addEventListener("change", loadReagentItemOptions);
document.getElementById("reg-reagent-instrument").addEventListener("change", loadReagentItemOptions);

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
  document.getElementById("reg-reagent-specimens").innerHTML = types
    .map((s) => `<label><input type="checkbox" value="${s.code}" />${s.code}（${s.name}）</label>`)
    .join("");
  document.getElementById("reg-rqc-specimen").innerHTML = types
    .map((s) => `<option value="${s.code}">${s.code}（${s.name}）</option>`)
    .join("");
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

// 2) 新增檢驗項目：成功後同步刷新試劑表單的項目選單
bindRegisterForm("add-item-form", "add-item-msg", "/api/items", { numbers: ["sort_order"] },
  () => { resyncRegCascade("reg-item-group", "reg-item-instrument"); loadReagentItemOptions(); });

// 3) 新增試劑：勾選的檢體代碼 → specimen_type_codes
bindRegisterForm(
  "add-reagent-form",
  "add-reagent-msg",
  "/api/reagents",
  {
    checkboxes: ["in_stock", "parallel_test_done", "same_lot_as_previous"],
    transform(payload, form) {
      payload.specimen_type_codes = [...form.querySelectorAll("#reg-reagent-specimens input:checked")]
        .map((c) => c.value);
    },
  },
  () => { resyncRegCascade("reg-reagent-group", "reg-reagent-instrument"); loadReagentItemOptions(); }
);

// 4) 新增品管液
bindRegisterForm("add-reagent-qc-form", "add-reagent-qc-msg", "/api/reagent-qc", {
  checkboxes: ["parallel_test_done", "in_use"],
  numbers: ["manufacturer_mean", "manufacturer_sd", "new_standard_mean", "new_standard_sd"],
}, () => resyncRegCascade("reg-rqc-group", "reg-rqc-instrument"));

// 5) 新增檢體類別：成功後刷新選項與清單
bindRegisterForm("add-specimen-form", "add-specimen-msg", "/api/specimen-types", {}, () => {
  loadSpecimenOptions();
  loadSpecimenTable();
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
    },
    template: `[
  { "instrument_serial_number": "43056", "item_code": "RBC", "item_name": "Red Blood Cell Count", "unit": "10^6/uL", "sort_order": 1 },
  { "instrument_serial_number": "43056", "item_code": "HGB", "item_name": "Hemoglobin", "unit": "g/dL", "sort_order": 2 }
]`,
    onSuccess: () => loadReagentItemOptions(),
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
  rqc: {
    path: "/api/reagent-qc",
    schema: {
      instrument_serial_number: ["string", true],
      specimen_type_code: ["string", false],
      test_item: ["string", true],
      test_item_full_name: ["string", false],
      qc_level: ["string", true],
      qc_lot_number: ["string", true],
      unit: ["string", false],
      manufacturer_mean: ["number", false],
      manufacturer_sd: ["number", false],
      parallel_test_done: ["boolean", false],
      parallel_test_date: ["string", false],
      new_standard_mean: ["number", false],
      new_standard_sd: ["number", false],
      in_use: ["boolean", false],
      remark: ["string", false],
    },
    template: `{
  "instrument_serial_number": "43056",
  "specimen_type_code": "B",
  "test_item": "Na",
  "qc_level": "Level 1",
  "qc_lot_number": "QC-NA-B1-2026",
  "unit": "mmol/L",
  "manufacturer_mean": 140.0,
  "manufacturer_sd": 2.5,
  "parallel_test_done": false,
  "in_use": true
}`,
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
