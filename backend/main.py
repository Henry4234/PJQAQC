"""QAQC 管理系統後端 (FastAPI)。

職責：
  - 連線 MySQL 讀寫品管紀錄 (qc_records) 與儀器主檔 (instruments)
  - 提供 Dashboard 統計指標 API
  - 提供品管紀錄的查詢 / 新增 API（新增時自動計算 z-score 與 Westgard 判讀）
  - 提供前端靜態網頁
"""
from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import database as db
import westgard

load_dotenv()

app = FastAPI(title="QAQC 管理系統 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# AI 判讀設定
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "claude-opus-4-8")
GUIDE_PATH = Path(__file__).resolve().parent / "westgard_guide.md"


# ----------------------------- 資料模型 ----------------------------- #
class QCRecordIn(BaseModel):
    instrument_name: str
    instrument_serial_number: str
    department: str | None = None
    qc_date: str = Field(..., description="YYYY-MM-DD")
    qc_time: str = Field(..., description="HH:MM:SS")
    operator: str | None = None
    test_item: str
    test_item_full_name: str | None = None
    qc_level: str | None = None
    qc_lot_number: str | None = None
    qc_result_value: float
    unit: str | None = None
    lot_mean: float
    lot_standard_deviation: float
    acceptable_range_lower: float | None = None
    acceptable_range_upper: float | None = None
    remark: str | None = None


# ----------------------------- 工具函式 ----------------------------- #
def _compute_z(value: float, mean: float, sd: float) -> float | None:
    if sd in (None, 0):
        return None
    return round((value - mean) / sd, 2)


def _today_str() -> str:
    return date.today().isoformat()


def _serials_in_group(lab_group: str) -> list[str]:
    rows = db.fetch_all(
        "SELECT serial_number FROM instruments WHERE lab_group = %s",
        (lab_group,),
    )
    return [r["serial_number"] for r in rows]


# ------------------------------- API ------------------------------- #
@app.get("/api/instruments")
def list_instruments():
    """回傳儀器主檔，依組別分群，供前端雙層選單使用。"""
    rows = db.fetch_all(
        "SELECT * FROM instruments WHERE active = TRUE "
        "ORDER BY lab_group, instrument_name, machine_role"
    )
    grouped: dict[str, list] = {}
    for r in rows:
        grouped.setdefault(r["lab_group"], []).append(r)
    return {"groups": grouped, "all": rows}


@app.get("/api/test-items")
def list_test_items(instrument_serial_number: str | None = Query(None)):
    """回傳某儀器（或全部）有紀錄的檢驗項目清單，供 L-J chart 選單使用。"""
    if instrument_serial_number:
        rows = db.fetch_all(
            "SELECT DISTINCT test_item, test_item_full_name FROM qc_records "
            "WHERE instrument_serial_number = %s ORDER BY test_item",
            (instrument_serial_number,),
        )
    else:
        rows = db.fetch_all(
            "SELECT DISTINCT test_item, test_item_full_name FROM qc_records "
            "ORDER BY test_item"
        )
    return [{"test_item": r["test_item"], "test_item_full_name": r.get("test_item_full_name")} for r in rows]


@app.get("/api/records")
def list_records(
    date_from: str | None = Query(None, description="起始日期 YYYY-MM-DD"),
    date_to: str | None = Query(None, description="結束日期 YYYY-MM-DD"),
    qc_date: str | None = Query(None, description="單一日期（向下相容）"),
    lab_group: str | None = Query(None, description="組別"),
    instrument_serial_number: str | None = Query(None, description="儀器 S/N"),
    test_item: str | None = Query(None),
    limit: int = Query(500, le=2000),
):
    conditions = []
    params: list = []

    if qc_date:
        conditions.append("qc_date = %s")
        params.append(qc_date)
    if date_from:
        conditions.append("qc_date >= %s")
        params.append(date_from)
    if date_to:
        conditions.append("qc_date <= %s")
        params.append(date_to)
    if instrument_serial_number:
        conditions.append("instrument_serial_number = %s")
        params.append(instrument_serial_number)
    elif lab_group:
        serials = _serials_in_group(lab_group)
        if serials:
            placeholders = ", ".join(["%s"] * len(serials))
            conditions.append(f"instrument_serial_number IN ({placeholders})")
            params.extend(serials)
        else:
            return []
    if test_item:
        conditions.append("test_item = %s")
        params.append(test_item)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"SELECT * FROM qc_records {where} ORDER BY qc_date DESC, qc_time DESC LIMIT %s"
    params.append(limit)
    return db.fetch_all(sql, tuple(params))


@app.post("/api/records")
def create_record(rec: QCRecordIn):
    z = _compute_z(rec.qc_result_value, rec.lot_mean, rec.lot_standard_deviation)

    history = db.fetch_all(
        "SELECT z_score, qc_date, qc_time FROM qc_records "
        "WHERE instrument_serial_number = %s AND test_item = %s AND qc_level = %s "
        "ORDER BY qc_date, qc_time",
        (rec.instrument_serial_number, rec.test_item, rec.qc_level),
    )
    z_series = [h["z_score"] for h in history if h["z_score"] is not None]
    if z is not None:
        z_series.append(z)

    rules = westgard.evaluate_series(z_series)
    status = westgard.status_from_rules(rules)
    violation = ", ".join(rules) if rules else None

    payload = rec.model_dump()
    payload.update(
        {
            "z_score": z,
            "qc_status": status,
            "westgard_rule_violation": violation,
        }
    )
    if not payload.get("remark"):
        payload["remark"] = (
            "Within acceptable range" if status == "Pass" else f"Westgard 違規: {violation}"
        )

    row = db.insert_returning("qc_records", payload)
    if not row:
        raise HTTPException(status_code=500, detail="新增失敗")
    return row


@app.get("/api/dashboard")
def dashboard(target_date: str | None = Query(None, description="預設今天")):
    day = target_date or _today_str()
    rows = db.fetch_all("SELECT * FROM qc_records WHERE qc_date = %s", (day,))

    total = len(rows)
    failed = [r for r in rows if r["qc_status"] == "Fail"]
    warning = [r for r in rows if r["qc_status"] == "Warning"]
    passed = [r for r in rows if r["qc_status"] == "Pass"]
    westgard_violations = [r for r in rows if r.get("westgard_rule_violation")]

    pass_rate = round(len(passed) / total * 100, 1) if total else 0.0

    by_instrument: dict[str, dict] = {}
    for r in rows:
        name = r["instrument_name"]
        d = by_instrument.setdefault(name, {"total": 0, "fail": 0})
        d["total"] += 1
        if r["qc_status"] == "Fail":
            d["fail"] += 1

    rule_counts: dict[str, int] = {}
    for r in westgard_violations:
        for rule in str(r["westgard_rule_violation"]).split(","):
            rule = rule.strip()
            if rule:
                rule_counts[rule] = rule_counts.get(rule, 0) + 1

    return {
        "date": day,
        "total_qc": total,
        "pass_count": len(passed),
        "warning_count": len(warning),
        "fail_count": len(failed),
        "westgard_violation_count": len(westgard_violations),
        "pass_rate": pass_rate,
        "by_instrument": by_instrument,
        "rule_counts": rule_counts,
        "violations": [
            {
                "instrument_name": r["instrument_name"],
                "test_item": r["test_item"],
                "qc_level": r["qc_level"],
                "z_score": r["z_score"],
                "westgard_rule_violation": r["westgard_rule_violation"],
                "qc_status": r["qc_status"],
                "qc_time": r["qc_time"],
                "remark": r["remark"],
            }
            for r in westgard_violations
        ],
    }


class AIInterpretIn(BaseModel):
    lab_group: str | None = None
    instrument_serial_number: str | None = None
    date_from: str | None = None
    date_to: str | None = None
    test_item: str | None = None


def _load_guide() -> str:
    try:
        return GUIDE_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "你是一位醫學檢驗品保專家，請依 Westgard 多規則判讀品管數據，並以繁體中文回覆。"


def _format_records_for_ai(rows: list[dict]) -> str:
    header = (
        "| 日期 | 時間 | 儀器 | S/N | 項目 | 濃度 | 結果 | 單位 | 均值 | SD | Z-score | 狀態 | Westgard |\n"
        "|------|------|------|-----|------|------|------|------|------|----|---------|------|----------|\n"
    )
    lines = []
    for r in rows:
        lines.append(
            f"| {r['qc_date']} | {r.get('qc_time','')} | {r['instrument_name']} | "
            f"{r['instrument_serial_number']} | {r['test_item']} | {r.get('qc_level','')} | "
            f"{r.get('qc_result_value','')} | {r.get('unit','')} | {r.get('lot_mean','')} | "
            f"{r.get('lot_standard_deviation','')} | {r.get('z_score','')} | {r['qc_status']} | "
            f"{r.get('westgard_rule_violation') or '-'} |"
        )
    return header + "\n".join(lines)


@app.post("/api/ai-interpret")
def ai_interpret(req: AIInterpretIn):
    """提取所選品管資料，連線 Claude 進行 Westgard 規則 AI 判讀。"""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=400,
            detail="尚未設定 ANTHROPIC_API_KEY，請於 backend/.env 填入 Anthropic API 金鑰後重啟伺服器。",
        )

    conditions = []
    params: list = []

    if req.date_from:
        conditions.append("qc_date >= %s")
        params.append(req.date_from)
    if req.date_to:
        conditions.append("qc_date <= %s")
        params.append(req.date_to)
    if req.instrument_serial_number:
        conditions.append("instrument_serial_number = %s")
        params.append(req.instrument_serial_number)
    elif req.lab_group:
        serials = _serials_in_group(req.lab_group)
        if serials:
            placeholders = ", ".join(["%s"] * len(serials))
            conditions.append(f"instrument_serial_number IN ({placeholders})")
            params.extend(serials)
        else:
            raise HTTPException(status_code=404, detail="此條件下查無品管資料，無法判讀。")
    if req.test_item:
        conditions.append("test_item = %s")
        params.append(req.test_item)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"SELECT * FROM qc_records {where} ORDER BY qc_date, qc_time LIMIT 1000"
    rows = db.fetch_all(sql, tuple(params))

    if not rows:
        raise HTTPException(status_code=404, detail="此條件下查無品管資料，無法判讀。")

    guide = _load_guide()
    scope = (
        f"組別: {req.lab_group or '全部'}｜儀器 S/N: {req.instrument_serial_number or '全部'}｜"
        f"檢驗項目: {req.test_item or '全部'}｜期間: {req.date_from or '不限'} ~ {req.date_to or '不限'}"
    )
    data_md = _format_records_for_ai(rows)
    user_prompt = (
        f"以下是需要判讀的品管數據（共 {len(rows)} 筆）。\n\n"
        f"**查詢範圍**：{scope}\n\n"
        f"{data_md}\n\n"
        "請依指南進行專業判讀並提出矯正建議。"
    )

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        message = client.messages.create(
            model=AI_MODEL,
            max_tokens=8000,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": guide,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
    except anthropic.APIStatusError as e:
        raise HTTPException(status_code=502, detail=f"Claude API 錯誤 ({e.status_code}): {e.message}")
    except anthropic.APIConnectionError:
        raise HTTPException(status_code=502, detail="無法連線至 Claude API，請檢查網路。")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"AI 判讀失敗: {e}")

    if message.stop_reason == "refusal":
        raise HTTPException(status_code=400, detail="模型基於安全考量婉拒此請求。")

    text = "".join(b.text for b in message.content if b.type == "text")
    return {
        "record_count": len(rows),
        "scope": scope,
        "model": AI_MODEL,
        "interpretation": text,
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "time": datetime.now().isoformat()}


# ----------------------------- 靜態前端 ----------------------------- #
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
