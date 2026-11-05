"""QAQC 管理系統後端（v3 分層式架構）。

職責分工：
  main.py     — 讀取類 API、Dashboard、L-J、關聯圖，以及 app 組裝
  register.py — 新增類 API（主檔 / 批號 / 關聯 / 品管執行 / 校正）
  manage.py   — 修改與停用／刪除類 API
  ai_interpret.py — AI 品管判讀（品管資料 JSON、Claude / OpenAI）
  westgard.py — 純判讀邏輯

核心概念：assay = 儀器 × 檢驗項目 × 檢體別。品管判讀一律綁儀器
（Westgard 連續規則須分機器各自成序列）。
"""
from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import ai_interpret
import database as db
import manage
import register

load_dotenv()

PRODUCTION = os.environ.get("APP_ENV") == "production"


app = FastAPI(
    title="QAQC 品管管理系統 API", version="3.0.0",
    docs_url=None if PRODUCTION else "/docs",
    redoc_url=None if PRODUCTION else "/redoc",
    openapi_url=None if PRODUCTION else "/openapi.json",
)
if PRODUCTION:
    from production import configure_production

    configure_production(app)
else:
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )

    @app.get("/api/auth/session", include_in_schema=False)
    def local_session() -> dict:
        """本機開發不經過登入，前端直接進入編輯者模式。"""
        return {"authenticated": True, "email": None, "local": True}

app.include_router(register.router)
app.include_router(manage.router)

ANTHROPIC_API_KEY = (
    os.environ.get("ANTHROPIC_API_KEY", "")
    if not PRODUCTION or os.environ.get("ENABLE_AI_INTERPRET") == "1" else ""
)
AI_MODEL = os.environ.get("AI_MODEL", "claude-opus-4-8")
GUIDE_PATH = Path(__file__).resolve().parent / "westgard_guide.md"


def _today() -> str:
    return date.today().isoformat()


# ============================ 主檔查詢 ============================ #
@app.get("/api/sections", summary="組別清單")
def list_sections():
    return db.fetch_all(
        "SELECT * FROM lab_sections WHERE active = TRUE ORDER BY section_name"
    )


@app.get("/api/instruments", summary="儀器清單（依組別分群）")
def list_instruments(include_inactive: bool = Query(False)):
    cond = "" if include_inactive else " AND i.active = TRUE"
    rows = db.fetch_all(
        "SELECT i.*, s.section_name, s.section_code, "
        "       p.serial_number AS backup_of_serial, p.instrument_name AS backup_of_name "
        "FROM instruments i "
        "JOIN lab_sections s ON s.section_id = i.section_id "
        "LEFT JOIN instruments p ON p.instrument_id = i.backup_of_instrument_id "
        f"WHERE 1=1{cond} "
        "ORDER BY s.section_name, i.instrument_name, i.instrument_role"
    )
    grouped: dict[str, list] = {}
    for r in rows:
        grouped.setdefault(r["section_name"], []).append(r)
    return {"groups": grouped, "all": rows}


@app.get("/api/specimen-types", summary="檢體別清單")
def list_specimen_types():
    return db.fetch_all(
        "SELECT * FROM specimen_types WHERE active = TRUE ORDER BY specimen_code"
    )


@app.get("/api/test-items", summary="全院檢驗項目字典")
def list_test_items(q: str | None = Query(None, description="代碼或名稱關鍵字")):
    if q:
        like = f"%{q}%"
        return db.fetch_all(
            "SELECT * FROM test_items WHERE active = TRUE "
            f"AND (item_code {db.CASE_INSENSITIVE_MATCH} %s "
            f"OR item_name {db.CASE_INSENSITIVE_MATCH} %s) ORDER BY item_code",
            (like, like),
        )
    return db.fetch_all("SELECT * FROM test_items WHERE active = TRUE ORDER BY item_code")


# ============================ assay（模型中心）============================ #
@app.get("/api/assays", summary="檢驗設定清單（儀器 × 項目 × 檢體）")
def list_assays(
    instrument_serial_number: str | None = Query(None),
    section_name: str | None = Query(None),
    item_code: str | None = Query(None),
    specimen_code: str | None = Query(None),
    include_inactive: bool = Query(False),
):
    conds, params = [], []
    if instrument_serial_number:
        conds.append("serial_number = %s")
        params.append(instrument_serial_number)
    if section_name:
        conds.append("section_name = %s")
        params.append(section_name)
    if item_code:
        conds.append("item_code = %s")
        params.append(item_code)
    if specimen_code:
        conds.append("specimen_code = %s")
        params.append(specimen_code)
    if not include_inactive:
        conds.append("active = TRUE")
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return db.fetch_all(
        f"SELECT * FROM v_assay_catalog {where} ORDER BY serial_number, item_code, specimen_code",
        tuple(params),
    )


def _assay_or_404(assay_id: str) -> dict:
    row = db.fetch_one("SELECT * FROM v_assay_catalog WHERE assay_id = %s", (assay_id,))
    if not row:
        raise HTTPException(status_code=404, detail=f"查無檢驗設定：{assay_id}")
    return row


@app.get("/api/assays/{assay_id}", summary="單一檢驗設定（含三種產品關聯與目前目標值）")
def get_assay(assay_id: str):
    row = _assay_or_404(assay_id)
    row["reagents"] = db.fetch_all(
        "SELECT p.*, r.reagent_role, r.required, r.priority "
        "FROM assay_reagent_requirements r "
        "JOIN reagent_products p ON p.reagent_product_id = r.reagent_product_id "
        "WHERE r.assay_id = %s ORDER BY r.priority, p.product_name",
        (assay_id,),
    )
    row["qc_products"] = db.fetch_all(
        "SELECT p.*, q.required, q.priority FROM assay_qc_requirements q "
        "JOIN qc_products p ON p.qc_product_id = q.qc_product_id "
        "WHERE q.assay_id = %s ORDER BY q.priority, p.product_name",
        (assay_id,),
    )
    row["calibrators"] = db.fetch_all(
        "SELECT p.*, c.required, c.priority FROM assay_calibrator_requirements c "
        "JOIN calibrator_products p ON p.calibrator_product_id = c.calibrator_product_id "
        "WHERE c.assay_id = %s ORDER BY c.priority, p.product_name",
        (assay_id,),
    )
    row["qc_targets"] = db.fetch_all(
        "SELECT t.*, l.lot_number, l.level_code, l.expiry_date, l.lot_status, "
        "       p.product_name AS qc_product_name "
        "FROM qc_target_values t "
        "JOIN qc_lots l ON l.qc_lot_id = t.qc_lot_id "
        "JOIN qc_products p ON p.qc_product_id = t.qc_product_id "
        "WHERE t.assay_id = %s AND t.effective_to IS NULL "
        "ORDER BY p.product_name, l.level_code",
        (assay_id,),
    )
    return row


# ============================ 產品與批號 ============================ #
def _products_with_lots(product_table: str, lot_table: str, fk: str,
                        lot_order: str, include_inactive: bool) -> list[dict]:
    """產品清單並掛上各自批號。

    批號以「一次查詢 + Python 分組」取得，避免每個產品各發一次查詢
    （每次查詢都會對 NAS 重開連線，N+1 在區域網路上很有感）。
    """
    cond = "" if include_inactive else "WHERE active = TRUE "
    products = db.fetch_all(f"SELECT * FROM {product_table} {cond}ORDER BY product_name")
    for p in products:
        p["lots"] = []
    if not products:
        return products
    index = {p[fk]: p for p in products}
    placeholders = ", ".join(["%s"] * len(index))
    lots = db.fetch_all(
        f"SELECT * FROM {lot_table} WHERE {fk} IN ({placeholders}) "
        "ORDER BY CASE lot_status WHEN 'IN_USE' THEN 1 WHEN 'AVAILABLE' THEN 2 "
        f"WHEN 'QUARANTINE' THEN 3 ELSE 0 END, {lot_order}",
        tuple(index.keys()),
    )
    for l in lots:
        owner = index.get(l[fk])
        if owner is not None:
            owner["lots"].append(l)
    return products


@app.get("/api/reagent-products", summary="試劑產品清單（含批號）")
def list_reagent_products(include_inactive: bool = Query(False)):
    return _products_with_lots("reagent_products", "reagent_lots",
                               "reagent_product_id", "expiry_date", include_inactive)


@app.get("/api/qc-products", summary="品管液產品清單（含批號與濃度）")
def list_qc_products(include_inactive: bool = Query(False)):
    return _products_with_lots("qc_products", "qc_lots",
                               "qc_product_id", "level_code", include_inactive)


@app.get("/api/calibrator-products", summary="校正液產品清單（含批號）")
def list_calibrator_products(include_inactive: bool = Query(False)):
    return _products_with_lots("calibrator_products", "calibrator_lots",
                               "calibrator_product_id", "level_code", include_inactive)


@app.get("/api/qc-lots", summary="品管液批號（可依產品 / 儀器過濾）")
def list_qc_lots(
    qc_product_id: str | None = Query(None),
    instrument_serial_number: str | None = Query(None),
):
    if instrument_serial_number:
        # 該儀器的 assay 允許使用的品管液產品，其所有批號
        return db.fetch_all(
            "SELECT DISTINCT l.*, p.product_name FROM qc_lots l "
            "JOIN qc_products p ON p.qc_product_id = l.qc_product_id "
            "JOIN assay_qc_requirements r ON r.qc_product_id = l.qc_product_id "
            "JOIN instrument_assays a ON a.assay_id = r.assay_id "
            "JOIN instruments i ON i.instrument_id = a.instrument_id "
            "WHERE i.serial_number = %s ORDER BY p.product_name, l.level_code",
            (instrument_serial_number,),
        )
    if qc_product_id:
        return db.fetch_all(
            "SELECT l.*, p.product_name FROM qc_lots l "
            "JOIN qc_products p ON p.qc_product_id = l.qc_product_id "
            "WHERE l.qc_product_id = %s ORDER BY l.level_code",
            (qc_product_id,),
        )
    return db.fetch_all(
        "SELECT l.*, p.product_name FROM qc_lots l "
        "JOIN qc_products p ON p.qc_product_id = l.qc_product_id "
        "ORDER BY p.product_name, l.level_code"
    )


# ============================ 品管目標值 ============================ #
@app.get("/api/qc-targets", summary="品管目標值（預設只列目前生效版本）")
def list_qc_targets(
    assay_id: str | None = Query(None),
    qc_lot_id: str | None = Query(None),
    instrument_serial_number: str | None = Query(None),
    include_history: bool = Query(False, description="連同已收效的舊版本一起列出"),
):
    conds, params = [], []
    if assay_id:
        conds.append("t.assay_id = %s")
        params.append(assay_id)
    if qc_lot_id:
        conds.append("t.qc_lot_id = %s")
        params.append(qc_lot_id)
    if instrument_serial_number:
        conds.append("v.serial_number = %s")
        params.append(instrument_serial_number)
    if not include_history:
        conds.append("t.effective_to IS NULL")
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return db.fetch_all(
        "SELECT t.*, v.serial_number, v.instrument_name, v.item_code, v.item_name, "
        "       v.specimen_code, v.result_unit, "
        "       l.lot_number, l.level_code, l.expiry_date, l.lot_status, "
        "       l.parallel_test_done, p.product_name AS qc_product_name "
        "FROM qc_target_values t "
        "JOIN v_assay_catalog v ON v.assay_id = t.assay_id "
        "JOIN qc_lots l ON l.qc_lot_id = t.qc_lot_id "
        "JOIN qc_products p ON p.qc_product_id = t.qc_product_id "
        f"{where} "
        "ORDER BY v.serial_number, v.item_code, l.level_code, t.effective_from DESC",
        tuple(params),
    )


@app.get("/api/qc-targets/pending-parallel-test", summary="待平測清單")
def pending_parallel_test(instrument_serial_number: str | None = Query(None)):
    """列出仍在用原廠值、尚未建立實驗室平測值的 assay × 批號。"""
    cond, params = "", []
    if instrument_serial_number:
        cond = "AND v.serial_number = %s "
        params.append(instrument_serial_number)
    return db.fetch_all(
        "SELECT t.qc_target_id, t.assay_id, t.qc_lot_id, t.target_mean, t.target_sd, "
        "       v.serial_number, v.instrument_name, v.item_code, v.specimen_code, "
        "       l.lot_number, l.level_code, l.expiry_date, l.parallel_test_done, "
        "       p.product_name AS qc_product_name "
        "FROM qc_target_values t "
        "JOIN v_assay_catalog v ON v.assay_id = t.assay_id "
        "JOIN qc_lots l ON l.qc_lot_id = t.qc_lot_id "
        "JOIN qc_products p ON p.qc_product_id = t.qc_product_id "
        "WHERE t.effective_to IS NULL AND t.target_source = 'MANUFACTURER' "
        f"{cond}"
        "ORDER BY v.serial_number, v.item_code, l.level_code",
        tuple(params),
    )


# ============================ 品管結果查詢 ============================ #
@app.get("/api/qc-results", summary="品管紀錄查詢")
def list_qc_results(
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    section_name: str | None = Query(None),
    instrument_serial_number: str | None = Query(None),
    item_code: str | None = Query(None),
    specimen_code: str | None = Query(None),
    result_status: str | None = Query(None),
    limit: int = Query(500, le=5000),
):
    conds, params = [], []
    if date_from:
        conds.append("run_at >= %s")
        params.append(f"{date_from} 00:00:00")
    if date_to:
        conds.append(f"run_at < {db.NEXT_DAY}")
        params.append(date_to)
    if section_name:
        conds.append("section_name = %s")
        params.append(section_name)
    if instrument_serial_number:
        conds.append("serial_number = %s")
        params.append(instrument_serial_number)
    if item_code:
        conds.append("item_code = %s")
        params.append(item_code)
    if specimen_code:
        conds.append("specimen_code = %s")
        params.append(specimen_code)
    if result_status:
        conds.append("result_status = %s")
        params.append(result_status)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(limit)
    return db.fetch_all(
        f"SELECT * FROM v_qc_result_detail {where} ORDER BY run_at DESC LIMIT %s",
        tuple(params),
    )


@app.get("/api/qc-results/lj", summary="L-J chart 資料（依 assay + 品管批號分組）")
def lj_series(
    instrument_serial_number: str = Query(...),
    item_code: str = Query(...),
    specimen_code: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
):
    conds = ["serial_number = %s", "item_code = %s"]
    params: list = [instrument_serial_number, item_code]
    if specimen_code:
        conds.append("specimen_code = %s")
        params.append(specimen_code)
    if date_from:
        conds.append("run_at >= %s")
        params.append(f"{date_from} 00:00:00")
    if date_to:
        conds.append(f"run_at < {db.NEXT_DAY}")
        params.append(date_to)
    rows = db.fetch_all(
        "SELECT * FROM v_qc_result_detail WHERE " + " AND ".join(conds) + " ORDER BY run_at",
        tuple(params),
    )
    # 依「品管液批號 + 濃度」分組，各成一張圖
    series: dict[str, dict] = {}
    for r in rows:
        key = f"{r['qc_product_name']} · {r['qc_level']} · {r['qc_lot_number']}"
        s = series.setdefault(key, {
            "label": key,
            "qc_product_name": r["qc_product_name"],
            "qc_level": r["qc_level"],
            "qc_lot_number": r["qc_lot_number"],
            "unit": r["unit_snapshot"],
            "mean": r["target_mean_snapshot"],
            "sd": r["target_sd_snapshot"],
            "points": [],
        })
        s["points"].append({
            "run_at": r["run_at"], "value": r["result_value"], "z": r["z_score"],
            "status": r["result_status"], "westgard": r["westgard_flags"],
        })
    return list(series.values())


# ============================ Dashboard ============================ #
@app.get("/api/dashboard", summary="儀表板統計")
def dashboard(target_date: str | None = Query(None, description="預設今天")):
    day = target_date or _today()
    rows = db.fetch_all(
        "SELECT * FROM v_qc_result_detail "
        f"WHERE run_at >= %s AND run_at < {db.NEXT_DAY}",
        (f"{day} 00:00:00", day),
    )

    passed = [r for r in rows if r["result_status"] == "PASS"]
    warning = [r for r in rows if r["result_status"] == "WARNING"]
    failed = [r for r in rows if r["result_status"] == "FAIL"]
    violations = [r for r in rows if r.get("westgard_flags")]

    by_instrument: dict[str, dict] = {}
    for r in rows:
        d = by_instrument.setdefault(r["instrument_name"], {"total": 0, "fail": 0})
        d["total"] += 1
        if r["result_status"] == "FAIL":
            d["fail"] += 1

    rule_counts: dict[str, int] = {}
    for r in violations:
        flags = r["westgard_flags"]
        for rule in (flags if isinstance(flags, list) else [flags]):
            if rule:
                rule_counts[str(rule)] = rule_counts.get(str(rule), 0) + 1

    return {
        "date": day,
        "total_qc": len(rows),
        "pass_count": len(passed),
        "warning_count": len(warning),
        "fail_count": len(failed),
        "westgard_violation_count": len(violations),
        "pass_rate": round(len(passed) / len(rows) * 100, 1) if rows else 0.0,
        "by_instrument": by_instrument,
        "rule_counts": rule_counts,
        "violations": [
            {
                "instrument_name": r["instrument_name"],
                "serial_number": r["serial_number"],
                "item_code": r["item_code"],
                "specimen_code": r["specimen_code"],
                "qc_level": r["qc_level"],
                "z_score": r["z_score"],
                "westgard_flags": r["westgard_flags"],
                "result_status": r["result_status"],
                "run_at": r["run_at"],
                "note": r["note"],
            }
            for r in violations
        ],
    }


# ============================ 主檔關聯圖 ============================ #
@app.get("/api/er-graph", summary="某儀器的主檔關聯圖")
def er_graph(instrument_serial_number: str = Query(...)):
    """回傳 儀器 → 品管液 → 試劑 → assay（項目×檢體）的節點與邊。"""
    inst = db.fetch_one(
        "SELECT i.*, s.section_name FROM instruments i "
        "JOIN lab_sections s ON s.section_id = i.section_id WHERE i.serial_number = %s",
        (instrument_serial_number,),
    )
    if not inst:
        raise HTTPException(status_code=404, detail=f"查無此儀器：{instrument_serial_number}")

    sn = (instrument_serial_number,)
    assays = db.fetch_all(
        "SELECT assay_id, item_code, item_name, specimen_code, result_unit "
        "FROM v_assay_catalog WHERE serial_number = %s AND active = TRUE "
        "ORDER BY item_code, specimen_code",
        sn,
    )
    reagents = db.fetch_all(
        "SELECT DISTINCT p.reagent_product_id, p.product_name, p.manufacturer "
        "FROM assay_reagent_requirements r "
        "JOIN reagent_products p ON p.reagent_product_id = r.reagent_product_id "
        "JOIN instrument_assays a ON a.assay_id = r.assay_id "
        "JOIN instruments i ON i.instrument_id = a.instrument_id "
        "WHERE i.serial_number = %s ORDER BY p.product_name",
        sn,
    )
    qcs = db.fetch_all(
        "SELECT DISTINCT p.qc_product_id, p.product_name, p.manufacturer "
        "FROM assay_qc_requirements q "
        "JOIN qc_products p ON p.qc_product_id = q.qc_product_id "
        "JOIN instrument_assays a ON a.assay_id = q.assay_id "
        "JOIN instruments i ON i.instrument_id = a.instrument_id "
        "WHERE i.serial_number = %s ORDER BY p.product_name",
        sn,
    )
    # 每個試劑/品管液產品目前使用中的批號，顯示在節點上
    for r in reagents:
        r["lots"] = db.fetch_all(
            "SELECT lot_number, expiry_date, lot_status, parallel_test_done "
            "FROM reagent_lots WHERE reagent_product_id = %s "
            "AND lot_status IN ('IN_USE','AVAILABLE') ORDER BY expiry_date",
            (r["reagent_product_id"],),
        )
    for q in qcs:
        q["lots"] = db.fetch_all(
            "SELECT lot_number, level_code, expiry_date, lot_status, parallel_test_done "
            "FROM qc_lots WHERE qc_product_id = %s "
            "AND lot_status IN ('IN_USE','AVAILABLE') ORDER BY level_code",
            (q["qc_product_id"],),
        )

    reagent_assay = db.fetch_all(
        "SELECT r.reagent_product_id, r.assay_id, r.reagent_role "
        "FROM assay_reagent_requirements r "
        "JOIN instrument_assays a ON a.assay_id = r.assay_id "
        "JOIN instruments i ON i.instrument_id = a.instrument_id "
        "WHERE i.serial_number = %s",
        sn,
    )
    qc_assay = db.fetch_all(
        "SELECT q.qc_product_id, q.assay_id FROM assay_qc_requirements q "
        "JOIN instrument_assays a ON a.assay_id = q.assay_id "
        "JOIN instruments i ON i.instrument_id = a.instrument_id "
        "WHERE i.serial_number = %s",
        sn,
    )
    # 品管液 → 試劑：兩者同時服務同一個 assay 即視為相關
    qc_reagent = db.fetch_all(
        "SELECT DISTINCT q.qc_product_id, r.reagent_product_id "
        "FROM assay_qc_requirements q "
        "JOIN assay_reagent_requirements r ON r.assay_id = q.assay_id "
        "JOIN instrument_assays a ON a.assay_id = q.assay_id "
        "JOIN instruments i ON i.instrument_id = a.instrument_id "
        "WHERE i.serial_number = %s",
        sn,
    )

    return {
        "instrument": inst,
        "assays": assays,
        "reagents": reagents,
        "qc_products": qcs,
        "edges": {
            "qc_reagent": qc_reagent,
            "reagent_assay": reagent_assay,
            "qc_assay": qc_assay,
        },
        "counts": {
            "assays": len(assays),
            "reagents": len(reagents),
            "qc_products": len(qcs),
            "reagent_assay_links": len(reagent_assay),
            "qc_assay_links": len(qc_assay),
        },
    }


# ============================ AI 判讀 ============================ #
class AIInterpretIn(BaseModel):
    section_name: str | None = None
    instrument_serial_number: str | None = None
    item_code: str | None = None
    date_from: str | None = None
    date_to: str | None = None


def _load_guide() -> str:
    try:
        return GUIDE_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "你是一位醫學檢驗品保專家，請依 Westgard 多規則判讀品管數據，並以繁體中文回覆。"


def _format_for_ai(rows: list[dict]) -> str:
    header = (
        "| 時間 | 儀器 | 項目 | 檢體 | 品管液 | 濃度 | 批號 | 結果 | 單位 | Mean | SD | Z | 狀態 | Westgard |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    )
    lines = []
    for r in rows:
        flags = r.get("westgard_flags")
        flags = ", ".join(flags) if isinstance(flags, list) else (flags or "-")
        lines.append(
            f"| {r['run_at']} | {r['instrument_name']} | {r['item_code']} | {r['specimen_code']} | "
            f"{r['qc_product_name']} | {r['qc_level']} | {r['qc_lot_number']} | "
            f"{r['result_value']} | {r.get('unit_snapshot') or ''} | "
            f"{r.get('target_mean_snapshot') or ''} | {r.get('target_sd_snapshot') or ''} | "
            f"{r.get('z_score') or ''} | {r['result_status']} | {flags} |"
        )
    return header + "\n".join(lines)


@app.post("/api/ai-interpret", summary="AI 品管判讀")
def ai_interpret(req: AIInterpretIn):
    if PRODUCTION and not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="正式環境尚未啟用 AI 判讀。")
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=400,
            detail="尚未設定 ANTHROPIC_API_KEY，請於 backend/.env 填入後重啟伺服器。",
        )
    rows = list_qc_results(
        date_from=req.date_from, date_to=req.date_to, section_name=req.section_name,
        instrument_serial_number=req.instrument_serial_number, item_code=req.item_code,
        specimen_code=None, result_status=None, limit=1000,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="此條件下查無品管資料，無法判讀。")


@app.get("/api/ready")
def ready():
    try:
        db.fetch_one("SELECT 1 FROM lab_sections LIMIT 1")
    except db.DATABASE_ERRORS:
        raise HTTPException(status_code=503, detail="資料庫尚未就緒") from None
    return {"status": "ready"}


@app.exception_handler(db.DATA_ERRORS[0])
async def invalid_database_value(request: Request, exc: Exception):
    return JSONResponse({"detail": "資料格式或數值範圍不正確"}, status_code=422)


@app.get("/api/ready")
def ready():
    try:
        db.fetch_one("SELECT 1 FROM lab_sections LIMIT 1")
    except db.DATABASE_ERRORS:
        raise HTTPException(status_code=503, detail="資料庫尚未就緒") from None
    return {"status": "ready"}


@app.exception_handler(db.DATA_ERRORS[0])
async def invalid_database_value(request: Request, exc: Exception):
    return JSONResponse({"detail": "資料格式或數值範圍不正確"}, status_code=422)


# ----------------------------- 靜態前端 ----------------------------- #
# 正式環境的前端由 Cloudflare Worker 提供；這裡只服務本機開發。
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if not PRODUCTION and FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
