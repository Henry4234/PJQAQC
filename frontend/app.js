// QAQC 前端邏輯：與 FastAPI 後端 (/api/*) 溝通，渲染儀表板、紀錄、新增表單。
const API = ""; // 與後端同源；若分開部署可改成 http://localhost:8000

// ---------- Tab 切換 ----------
const tabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");
tabs.forEach((t) => {
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    views.forEach((v) => v.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("view-" + t.dataset.view).classList.add("active");
    if (t.dataset.view === "records") loadRecords();
    if (t.dataset.view === "lj") openLJ();
    if (t.dataset.view === "ai") openAI();
  });
});

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

// 新增分頁：依選中的儀器自動帶入 instrument_name 與科別
function syncAddInstrumentMeta() {
  const sn = document.getElementById("add-instrument").value;
  const inst = INSTRUMENTS.all.find((i) => i.serial_number === sn);
  document.getElementById("add-instrument-name").value = inst ? inst.instrument_name : "";
  document.getElementById("add-department").value = inst ? inst.department || "" : "";
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
      tbody.innerHTML = `<tr><td colspan="13" class="empty">無資料</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `
      <tr>
        <td>${r.qc_date}</td><td>${r.qc_time}</td><td>${r.instrument_name}</td>
        <td>${r.department ?? ""}</td><td>${r.test_item}</td><td>${r.qc_level ?? ""}</td>
        <td>${r.qc_result_value ?? ""}</td><td>${r.unit ?? ""}</td>
        <td>${r.lot_mean ?? ""}</td><td>${r.lot_standard_deviation ?? ""}</td>
        <td>${r.z_score ?? ""}</td>
        <td><span class="badge ${r.qc_status}">${r.qc_status}</span></td>
        <td class="wg">${r.westgard_rule_violation ?? "-"}</td>
      </tr>`
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty">載入失敗：${e.message}</td></tr>`;
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

  // 背景繪圖區
  svg.appendChild(el("rect", { x: m.left, y: m.top, width: plotW, height: plotH, fill: "#16202f", stroke: "#334155" }));

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
    const c = el("circle", { cx, cy, r: 4.5, fill: statusColor[p.status] || "#38bdf8", stroke: "#0f172a", "stroke-width": 1 });
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
  loadDashboard();
})();
