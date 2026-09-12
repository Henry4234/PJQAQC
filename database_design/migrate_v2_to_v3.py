"""PJQAQC v2 → v3 分層式架構遷移（一次性）。

流程：讀取舊資料 → 套用 backend/init_db.sql（drop + create + seed）→ 寫入遷移後資料。

使用者裁示（2026-09-12）：
  1. `-U` 後綴項目拆開：CRE-U → item_code=CRE + specimen=URINE
  2. XN-3000 的 CBC 品管液涵蓋全部 17 項 assay
  3. 12887 的 P.T 試劑由 Pathromtin SL 更正為 Thromborel S
  4. 43052（XN-3000 備機）由主機 43056 複製試劑與品管液關聯

其他處理：
  * reagent_qc 與 reagent_qc_lot 的 current 批號矛盾時，以 reagent_qc 為準
    （QC-XN-L*-2026 為早期範例資料，予以捨棄）
  * 主備機配對寫入 instruments.backup_of_instrument_id
"""
import sys, io, re, uuid, datetime
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from pathlib import Path
from collections import defaultdict
import pymysql

DB = dict(host="192.168.0.111", port=3306, user="PJQAQC",
          password="UMnrRrv!ZR6a*LRX", database="PJQAQC", charset="utf8mb4",
          cursorclass=pymysql.cursors.DictCursor)
SQL_FILE = Path(__file__).resolve().parent.parent / "backend" / "init_db.sql"
NOW = datetime.datetime.now()
nid = lambda: str(uuid.uuid4())
report = []


def log(msg):
    print(msg)
    report.append(msg)


# ==================== 1. 讀取舊資料 ====================
conn = pymysql.connect(**DB)
cur = conn.cursor()

old = {}
for t in ("lab_group", "instruments", "items", "specimen_type", "reagent",
          "reagent_qc", "reagent_qc_lot", "reagent_item_map",
          "reagent_specimen_map", "qc_reagent_map"):
    try:
        cur.execute(f"SELECT * FROM {t}")
        old[t] = cur.fetchall()
    except pymysql.err.ProgrammingError:
        old[t] = []
log("== 舊資料讀取 ==")
for t, rows in old.items():
    log(f"  {t:22s} {len(rows)}")

# 建立舊 ID 對照
old_group = {g["group_id"]: g for g in old["lab_group"]}
old_inst = {i["serial_number"]: i for i in old["instruments"]}
old_item = {i["item_id"]: i for i in old["items"]}
old_reagent = {r["reagent_id"]: r for r in old["reagent"]}
old_rqc = {q["reagent_qc_id"]: q for q in old["reagent_qc"]}
old_spec = {s["specimen_type_id"]: s for s in old["specimen_type"]}

# ==================== 2. 套用新 schema ====================
sql = SQL_FILE.read_text(encoding="utf-8-sig")
stmts = [s.strip() for s in
         "\n".join(l for l in sql.splitlines() if not l.strip().startswith("--")).split(";")
         if s.strip()]
log(f"\n== 套用新 schema（{len(stmts)} 條語句）==")
for s in stmts:
    cur.execute(s)
conn.commit()
cur.execute("SHOW TABLES")
log(f"  建立完成，共 {len(cur.fetchall())} 個物件")

# 取得種子資料的 UUID
cur.execute("SELECT section_id, section_name FROM lab_sections")
sec_by_name = {r["section_name"]: r["section_id"] for r in cur.fetchall()}
cur.execute("SELECT specimen_type_id, specimen_code FROM specimen_types")
spec_by_code = {r["specimen_code"]: r["specimen_type_id"] for r in cur.fetchall()}


def ins(table, data):
    cols = ", ".join(data)
    ph = ", ".join(["%s"] * len(data))
    cur.execute(f"INSERT INTO {table} ({cols}) VALUES ({ph})", tuple(data.values()))


# ==================== 3. instruments ====================
def model_of(name):
    """由儀器名稱推機型：去掉 -A/-B/-Line1/-Line2 等主備機後綴。"""
    m = re.sub(r"[-\s]*(Line\s*\d+|[AB])$", "", name).strip()
    return m or name


inst_id = {}      # serial_number -> new instrument_id
for i in sorted(old["instruments"], key=lambda x: (x["instrument_name"], x["machine_role"])):
    sn = i["serial_number"]
    inst_id[sn] = nid()
    ins("instruments", {
        "instrument_id": inst_id[sn],
        "section_id": sec_by_name[old_group[i["group_id"]]["group_name"]],
        "serial_number": sn,
        "instrument_name": i["instrument_name"],
        "model_name": model_of(i["instrument_name"]),
        "instrument_role": i["machine_role"],
        "active": i["active"],
    })

# 主備機配對：同機型、同組別，備機指向主機
primaries = {}
for i in old["instruments"]:
    if i["machine_role"] == "主機":
        primaries[(model_of(i["instrument_name"]), i["group_id"])] = i["serial_number"]
pairs = 0
for i in old["instruments"]:
    if i["machine_role"] == "備機":
        p = primaries.get((model_of(i["instrument_name"]), i["group_id"]))
        if p:
            cur.execute("UPDATE instruments SET backup_of_instrument_id=%s WHERE instrument_id=%s",
                        (inst_id[p], inst_id[i["serial_number"]]))
            pairs += 1
conn.commit()
log(f"\n== instruments：{len(inst_id)} 台，主備機配對 {pairs} 組 ==")

# ==================== 4. test_items + instrument_assays ====================
# 裁示①：`-U` 後綴 → 代碼去 -U、檢體 URINE
def split_code(code):
    if code.endswith("-U"):
        return code[:-2], "U"
    return code, "B"


ti_id = {}        # item_code -> test_item_id
ti_meta = {}
for it in old["items"]:
    code, _ = split_code(it["item_code"])
    if code not in ti_meta:
        ti_meta[code] = {"name": it.get("item_name"), "unit": it.get("unit")}
    else:
        ti_meta[code]["name"] = ti_meta[code]["name"] or it.get("item_name")
        ti_meta[code]["unit"] = ti_meta[code]["unit"] or it.get("unit")

for code, meta in sorted(ti_meta.items()):
    ti_id[code] = nid()
    ins("test_items", {
        "test_item_id": ti_id[code], "item_code": code,
        "item_name": meta["name"], "default_unit": meta["unit"],
    })

assay_id = {}     # (serial_number, item_code_raw) -> assay_id   ※以舊 item_code 當鍵方便回查
assay_by_route = {}  # (sn, test_item_code, specimen_code) -> assay_id
urine_items = set()
for it in old["items"]:
    sn = it["instrument_serial_number"]
    code, spec = split_code(it["item_code"])
    if spec == "U":
        urine_items.add(it["item_code"])
    aid = nid()
    assay_id[(sn, it["item_code"])] = aid
    assay_by_route[(sn, code, spec)] = aid
    ins("instrument_assays", {
        "assay_id": aid,
        "instrument_id": inst_id[sn],
        "test_item_id": ti_id[code],
        "specimen_type_id": spec_by_code[spec],
        "result_unit": it.get("unit"),
        "active": it.get("active", True),
    })
conn.commit()
log(f"\n== 項目：{len(old['items'])} 筆 items → {len(ti_id)} 個全院項目 + {len(assay_id)} 筆 assay ==")
log(f"   拆為 URINE 檢體：{sorted(urine_items)}")

# ==================== 5. reagent_products + reagent_lots ====================
def slug(name, used, maxlen=60):
    s = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").upper()[:maxlen] or "PROD"
    base, n = s, 1
    while s in used:
        n += 1
        s = f"{base[:maxlen-3]}-{n}"
    used.add(s)
    return s


rp_id, used_codes = {}, set()
for name in sorted({r["reagent_name"] for r in old["reagent"]}):
    rp_id[name] = nid()
    src = next(r for r in old["reagent"] if r["reagent_name"] == name)
    ins("reagent_products", {
        "reagent_product_id": rp_id[name],
        "product_code": slug(name, used_codes),
        "product_name": name,
        "manufacturer": src.get("manufacturer"),
    })

rl_id = {}   # (product_name, lot_number) -> reagent_lot_id
for r in old["reagent"]:
    key = (r["reagent_name"], r["lot_number"])
    if key in rl_id or not r["lot_number"]:
        continue
    rl_id[key] = nid()
    ins("reagent_lots", {
        "reagent_lot_id": rl_id[key],
        "reagent_product_id": rp_id[r["reagent_name"]],
        "lot_number": r["lot_number"],
        "received_at": r.get("in_stock_date"),
        "expiry_date": r.get("expiry_date"),
        "lot_status": "AVAILABLE" if r.get("in_stock") else "QUARANTINE",
        "parallel_test_done": r.get("parallel_test_done", False),
        "parallel_test_date": r.get("parallel_test_date"),
        "same_lot_as_previous": r.get("same_lot_as_previous", False),
        "note": r.get("remark"),
    })
conn.commit()
log(f"\n== 試劑：{len(old['reagent'])} 筆 → {len(rp_id)} 個產品 + {len(rl_id)} 個批號 ==")

# ==================== 6. assay_reagent_requirements ====================
# 來源 A：reagent_item_map（明確的試劑↔項目關聯）
# 來源 B：reagent.test_item + instrument（無 map 時的推導）
req = set()   # (assay_id, reagent_product_id, role)


def add_req(aid, pname, role="PRIMARY"):
    k = (aid, rp_id[pname], role)
    if aid and k not in req:
        req.add(k)
        ins("assay_reagent_requirements",
            {"assay_id": aid, "reagent_product_id": rp_id[pname], "reagent_role": role})


for m in old["reagent_item_map"]:
    it = old_item.get(m["item_id"])
    rg = old_reagent.get(m["reagent_id"])
    if it and rg:
        add_req(assay_id.get((it["instrument_serial_number"], it["item_code"])), rg["reagent_name"])

# 來源 B：以 reagent.test_item 對應同儀器同名項目
CORRECTIONS = []
for r in old["reagent"]:
    sn, item = r["instrument_serial_number"], r["test_item"]
    name = r["reagent_name"]
    # 裁示③：12887 的 P.T 由 Pathromtin SL 更正為 Thromborel S
    if sn == "12887" and item == "P.T" and name == "Pathromtin SL":
        CORRECTIONS.append(f"12887 P.T：Pathromtin SL → Thromborel S（依裁示更正）")
        name = "Thromborel S"
    aid = assay_id.get((sn, item))
    if aid:
        add_req(aid, name)
conn.commit()
log(f"\n== 試劑↔assay 關聯：{len(req)} 筆 ==")
for c in CORRECTIONS:
    log(f"   更正：{c}")
unlinked = [n for n in rp_id if not any(rp_id[n] == k[1] for k in req)]
if unlinked:
    log(f"   ⚠ 無任何 assay 關聯的試劑產品：{unlinked}")

# ==================== 7. qc_products + qc_lots + targets ====================
# 由 level_code 推導產品：共同的非數字前綴（如 "Ci-Trol 1"/"Ci-Trol 3" → 產品 Ci-Trol）
groups = defaultdict(list)
for q in old["reagent_qc"]:
    groups[q["test_item"]].append(q)

qp_id, ql_id = {}, {}     # product_name -> id ; (product_name, lot, level) -> id
qc_prod_of_item = {}      # old test_item -> product_name
used_qcodes = set()

# 「Level」「L」等只是濃度的通用寫法，不是產品名；遇到這類前綴改用項目名組成產品名
GENERIC_LEVEL_WORDS = {"level", "l", "lv", "濃度", "級"}

for item, rows in groups.items():
    levels = [r["qc_level"] or "" for r in rows]
    m = re.match(r"^(.*?)\s*\d+$", levels[0])
    prefix = m.group(1).strip() if m else ""
    if (prefix and prefix.lower() not in GENERIC_LEVEL_WORDS
            and all(l.startswith(prefix) for l in levels)):
        pname, strip_prefix = prefix, True          # 如 Ci-Trol 1/3 → 產品 Ci-Trol、濃度 1/3
    else:
        pname, strip_prefix = f"{item} 品管液", False  # 如 Level 1/2/3 → 產品「CBC 品管液」、濃度原樣
    qc_prod_of_item[item] = pname
    if pname not in qp_id:
        qp_id[pname] = nid()
        ins("qc_products", {"qc_product_id": qp_id[pname],
                            "product_code": slug(pname, used_qcodes),
                            "product_name": pname})

    for r in rows:
        lvl = (r["qc_level"] or "").strip()
        if strip_prefix:
            lvl = lvl[len(prefix):].strip() or lvl
        lot = r["qc_lot_number"]
        if not lot:
            continue
        key = (pname, lot, lvl)
        if key not in ql_id:
            ql_id[key] = nid()
            ins("qc_lots", {
                "qc_lot_id": ql_id[key], "qc_product_id": qp_id[pname],
                "lot_number": lot, "level_code": lvl,
                "expiry_date": r.get("expiry_date"),
                "received_at": r.get("lot_received_date"),
                "lot_status": "IN_USE" if r.get("in_use") else "AVAILABLE",
                "parallel_test_done": r.get("parallel_test_done", False),
                "parallel_test_date": r.get("parallel_test_date"),
            })

# 歷史批號（is_current=0），例如 P.T 的 564915
hist = 0
for l in old["reagent_qc_lot"]:
    if l.get("is_current"):
        continue
    q = old_rqc.get(l["reagent_qc_id"])
    if not q:
        continue
    pname = qc_prod_of_item[q["test_item"]]
    lvl = (q["qc_level"] or "").strip()
    m = re.match(r"^(.*?)\s*\d+$", lvl)
    if pname != f"{q['test_item']} 品管液" and m:
        lvl = lvl[len(pname):].strip() or lvl
    key = (pname, l["qc_lot_number"], lvl)
    if key not in ql_id:
        ql_id[key] = nid()
        ins("qc_lots", {
            "qc_lot_id": ql_id[key], "qc_product_id": qp_id[pname],
            "lot_number": l["qc_lot_number"], "level_code": lvl,
            "expiry_date": l.get("expiry_date"), "lot_status": "EXHAUSTED",
            "parallel_test_done": l.get("parallel_test_done", False),
            "note": "由 v2 批號歷程遷入",
        })
        hist += 1
conn.commit()
log(f"\n== 品管液：{len(qp_id)} 個產品 {list(qp_id)} + {len(ql_id)} 個批號（含 {hist} 筆歷史批號）==")

# --- assay_qc_requirements ---
# 裁示②：CBC 品管液涵蓋 XN-3000 全部 17 項
XN_CBC_SN = {q["instrument_serial_number"] for q in old["reagent_qc"] if q["test_item"] == "CBC"}
qcreq = set()


def add_qcreq(aid, pname):
    k = (aid, qp_id[pname])
    if aid and k not in qcreq:
        qcreq.add(k)
        ins("assay_qc_requirements", {"assay_id": aid, "qc_product_id": qp_id[pname]})


for q in old["reagent_qc"]:
    sn, item = q["instrument_serial_number"], q["test_item"]
    pname = qc_prod_of_item[item]
    if item == "CBC":
        for it in old["items"]:
            if it["instrument_serial_number"] == sn:
                add_qcreq(assay_id[(sn, it["item_code"])], pname)
    else:
        add_qcreq(assay_id.get((sn, item)), pname)
conn.commit()
log(f"== 品管液↔assay 關聯：{len(qcreq)} 筆 ==")

# --- qc_target_values（僅在有 mean/SD 時）---
tgt = 0
for q in old["reagent_qc"]:
    sn, item = q["instrument_serial_number"], q["test_item"]
    mean = q.get("new_standard_mean") or q.get("manufacturer_mean")
    sd = q.get("new_standard_sd") or q.get("manufacturer_sd")
    if mean is None or sd is None or float(sd) <= 0:
        continue
    src = "LAB" if q.get("new_standard_mean") is not None else "MANUFACTURER"
    pname = qc_prod_of_item[item]
    lvl = (q["qc_level"] or "").strip()
    m = re.match(r"^(.*?)\s*\d+$", lvl)
    if pname != f"{item} 品管液" and m:
        lvl = lvl[len(pname):].strip() or lvl
    lot_key = (pname, q["qc_lot_number"], lvl)
    aid = assay_id.get((sn, item))
    if not aid or lot_key not in ql_id:
        continue
    ins("qc_target_values", {
        "qc_target_id": nid(), "assay_id": aid, "qc_lot_id": ql_id[lot_key],
        "qc_product_id": qp_id[pname], "target_source": src,
        "target_mean": mean, "target_sd": sd,
        "effective_from": NOW, "note": "由 v2 遷入",
    })
    tgt += 1
conn.commit()
log(f"== 品管目標值：{tgt} 筆（無 mean/SD 者略過，如 CBC）==")

# ==================== 8. 裁示④：複製主機設定到 XN-3000 備機 ====================
SRC, DST = "43056", "43052"
copied_r = copied_q = 0
if SRC in inst_id and DST in inst_id:
    for (sn, code), aid in list(assay_id.items()):
        if sn != SRC:
            continue
        daid = assay_id.get((DST, code))
        if not daid:
            continue
        for (a, p, role) in list(req):
            if a == aid and (daid, p, role) not in req:
                req.add((daid, p, role))
                ins("assay_reagent_requirements",
                    {"assay_id": daid, "reagent_product_id": p, "reagent_role": role})
                copied_r += 1
        for (a, p) in list(qcreq):
            if a == aid and (daid, p) not in qcreq:
                qcreq.add((daid, p))
                ins("assay_qc_requirements", {"assay_id": daid, "qc_product_id": p})
                copied_q += 1
conn.commit()
log(f"\n== 複製 {SRC} → {DST}：試劑關聯 {copied_r} 筆、品管液關聯 {copied_q} 筆 ==")

# ==================== 9. 驗證 ====================
log("\n== 遷移後統計 ==")
for t in ("lab_sections", "instruments", "specimen_types", "test_items", "instrument_assays",
          "reagent_products", "reagent_lots", "assay_reagent_requirements",
          "qc_products", "qc_lots", "qc_target_values", "assay_qc_requirements",
          "calibrator_products", "calibrator_lots", "qc_runs", "qc_results"):
    cur.execute(f"SELECT COUNT(*) n FROM {t}")
    log(f"  {t:30s} {cur.fetchone()['n']}")

cur.execute("SELECT COUNT(*) n FROM v_assay_catalog")
log(f"  {'v_assay_catalog (view)':30s} {cur.fetchone()['n']}")

log("\n== 抽樣：同項目不同檢體（新設計核心）==")
cur.execute("""SELECT item_code, GROUP_CONCAT(DISTINCT specimen_code ORDER BY specimen_code) specs,
                      COUNT(*) n
               FROM v_assay_catalog GROUP BY item_code HAVING COUNT(DISTINCT specimen_code) > 1""")
for r in cur.fetchall():
    log(f"  {r['item_code']:10s} 檢體={r['specs']}  assay 數={r['n']}")

cur.execute("""SELECT i.serial_number, i.instrument_name, i.instrument_role,
                      p.serial_number AS backup_of
               FROM instruments i LEFT JOIN instruments p ON p.instrument_id=i.backup_of_instrument_id
               ORDER BY i.instrument_name""")
log("\n== 主備機配對 ==")
for r in cur.fetchall():
    log(f"  {r['serial_number']:8s} {r['instrument_name']:26s} {r['instrument_role']}"
        + (f"  →主機 {r['backup_of']}" if r["backup_of"] else ""))

cur.close()
conn.close()
Path(__file__).with_name("migration_report_v3.txt").write_text("\n".join(report), encoding="utf-8")
print("\n遷移完成，報告已寫入 database_design/migration_report_v3.txt")
