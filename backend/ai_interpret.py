"""AI 品管判讀：組出品管 JSON，再連同判讀指引送給 Claude 或 OpenAI。

  GET  /api/ai-providers  可用的 AI 供應商（只回傳是否已設定，不含金鑰）
  GET  /api/ai-qc-data    依頁面條件抓取品管原始資料，回傳實際送給 AI 的 JSON
  POST /api/ai-interpret  把上述 JSON 與 westgard_guide.md 送給 AI 判讀

金鑰只從環境變數（backend/.env）讀取。供應商的錯誤內容可能帶有遮罩後的金鑰，
因此一律換成固定訊息才回給前端，驗證失敗時也不寫入 log。
"""
from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import database as db

logger = logging.getLogger(__name__)
router = APIRouter()

GUIDE_PATH = Path(__file__).resolve().parent / "westgard_guide.md"

SCHEMA_VERSION = "pjqaqc.qc-ai-input.v1"
AI_MAX_RECORDS = 1000
AI_MAX_OUTPUT_TOKENS = 64000
AI_EFFORT = "medium"
AI_TIMEOUT_SECONDS = 300.0
AI_MAX_RETRIES = 1

# 這些模型支援由 API 端在安全分類誤判時自動改用其他模型重跑
ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01"
ANTHROPIC_FALLBACK_MODELS = {
    "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
}

# 只選判讀需要的欄位：operator_id、reviewed_by 等人員資料不送往外部 AI
_RESULT_COLUMNS = (
    "run_at, section_name, serial_number, instrument_name, instrument_role, "
    "item_code, item_name, specimen_code, specimen_name, "
    "qc_product_name, qc_lot_number, qc_level, "
    "result_value, unit_snapshot, target_mean_snapshot, target_sd_snapshot, "
    "z_score, result_status, westgard_flags, note"
)
_KNOWN_STATUSES = ("PASS", "WARNING", "FAIL", "INVALID")


# ============================ 品管資料 JSON ============================ #
def _flag_list(value: object) -> list[str]:
    if not value:
        return []
    return [str(f) for f in value] if isinstance(value, list) else [str(value)]


def build_qc_payload(
    *,
    date_from: date,
    date_to: date | None = None,
    section_name: str | None = None,
    instrument_serial_number: str | None = None,
    item_code: str | None = None,
) -> dict:
    """依條件抓取品管結果，組成送給 AI 的 JSON。

    一條 series 等於 Westgard 計算時用的一條序列（儀器 × 項目 × 檢體 × 品管批號），
    results 依時間由舊到新。超過上限時保留最新資料，並以 summary.truncated 標示。
    """
    if date_to and date_to < date_from:
        raise HTTPException(status_code=422, detail="結束日期不可早於起始日期。")

    conds = ["run_at >= %s"]
    params: list = [f"{date_from.isoformat()} 00:00:00"]
    if date_to:
        conds.append(f"run_at < {db.NEXT_DAY}")
        params.append(date_to.isoformat())
    for column, value in (
        ("section_name", section_name),
        ("serial_number", instrument_serial_number),
        ("item_code", item_code),
    ):
        if value:
            conds.append(f"{column} = %s")
            params.append(value)
    params.append(AI_MAX_RECORDS + 1)

    rows = db.fetch_all(
        f"SELECT {_RESULT_COLUMNS} FROM v_qc_result_detail "
        f"WHERE {' AND '.join(conds)} "
        "ORDER BY run_at DESC, qc_result_id DESC LIMIT %s",
        tuple(params),
    )
    truncated = len(rows) > AI_MAX_RECORDS
    rows = rows[:AI_MAX_RECORDS]
    rows.reverse()

    series: dict[tuple, dict] = {}
    status_counts = {status: 0 for status in _KNOWN_STATUSES}
    rule_counts: dict[str, int] = {}
    for r in rows:
        key = (r["serial_number"], r["item_code"], r["specimen_code"],
               r["qc_product_name"], r["qc_lot_number"], r["qc_level"])
        entry = series.setdefault(key, {
            "section_name": r["section_name"],
            "serial_number": r["serial_number"],
            "instrument_name": r["instrument_name"],
            "instrument_role": r["instrument_role"],
            "item_code": r["item_code"],
            "item_name": r["item_name"],
            "specimen_code": r["specimen_code"],
            "specimen_name": r["specimen_name"],
            "qc_product_name": r["qc_product_name"],
            "qc_lot_number": r["qc_lot_number"],
            "qc_level": r["qc_level"],
            "unit": r["unit_snapshot"],
            "results": [],
        })
        flags = _flag_list(r["westgard_flags"])
        entry["results"].append({
            "run_at": r["run_at"],
            "value": r["result_value"],
            "mean": r["target_mean_snapshot"],
            "sd": r["target_sd_snapshot"],
            "z": r["z_score"],
            "status": r["result_status"],
            "westgard_flags": flags,
            "note": r["note"],
        })
        status_counts[r["result_status"]] = status_counts.get(r["result_status"], 0) + 1
        for flag in flags:
            rule_counts[flag] = rule_counts.get(flag, 0) + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "query": {
            "section_name": section_name,
            "instrument_serial_number": instrument_serial_number,
            "item_code": item_code,
            "date_from": date_from.isoformat(),
            "date_to": date_to.isoformat() if date_to else None,
        },
        "summary": {
            "record_count": len(rows),
            "series_count": len(series),
            "truncated": truncated,
            "max_records": AI_MAX_RECORDS,
            "first_run_at": rows[0]["run_at"] if rows else None,
            "last_run_at": rows[-1]["run_at"] if rows else None,
            "status_counts": status_counts,
            "rule_counts": dict(sorted(rule_counts.items())),
        },
        "series": [series[key] for key in sorted(series, key=lambda k: tuple(map(str, k)))],
    }


def _user_message(payload: dict) -> str:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"<qc_data>\n{data}\n</qc_data>\n\n請依判讀指引判讀上述品管資料。"


# ============================ 供應商呼叫 ============================ #
@dataclass
class AIReply:
    text: str
    model: str
    incomplete: bool


def _status_message(label: str, status: int) -> str:
    if status in (401, 403):
        return f"{label} 金鑰無效或權限不足，請檢查 backend/.env 後重啟伺服器。"
    if status == 404:
        return f"{label} 找不到指定的模型，請檢查 backend/.env 的模型設定。"
    if status == 429:
        return f"{label} 請求過多或額度已用完，請稍後再試或檢查帳戶額度。"
    if status >= 500:
        return f"{label} 服務暫時無法使用，請稍後再試。"
    return f"{label} 拒絕了這次請求（HTTP {status}），詳情請看伺服器 log。"


@contextmanager
def _translate_errors(label: str, sdk):
    """把 SDK 例外換成固定訊息；`from None` 讓原始內容不會跟著例外鏈外流。"""
    try:
        yield
    except sdk.APIStatusError as e:
        status = e.status_code
        # 401/403 的錯誤內容可能含遮罩後的金鑰，只記狀態碼
        detail = "" if status in (401, 403) else str(e.message)[:300]
        logger.warning("%s API error: status=%s request_id=%s %s",
                       label, status, getattr(e, "request_id", None), detail)
        raise HTTPException(status_code=502, detail=_status_message(label, status)) from None
    except sdk.APITimeoutError:
        logger.warning("%s API timeout", label)
        raise HTTPException(status_code=504, detail=f"{label} 回應逾時，請縮小查詢範圍後再試。") from None
    except sdk.APIError as e:
        logger.warning("%s API failure: %s", label, type(e).__name__)
        raise HTTPException(status_code=502, detail=f"無法連線至 {label}，請檢查網路後再試。") from None


def _call_anthropic(api_key: str, model: str, system: str, user: str) -> AIReply:
    import anthropic

    client = anthropic.Anthropic(
        api_key=api_key, timeout=AI_TIMEOUT_SECONDS, max_retries=AI_MAX_RETRIES,
    )
    fallback = (
        {"betas": [ANTHROPIC_FALLBACK_BETA], "fallbacks": "default"}
        if model in ANTHROPIC_FALLBACK_MODELS else {}
    )
    with _translate_errors("Claude", anthropic):
        with client.beta.messages.stream(
            model=model,
            max_tokens=AI_MAX_OUTPUT_TOKENS,
            thinking={"type": "adaptive"},
            output_config={"effort": AI_EFFORT},
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
            **fallback,
        ) as stream:
            message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise HTTPException(status_code=422, detail="Claude 的安全機制拒絕了這次請求，請改用 OpenAI 或調整查詢範圍。")

    # 串流中途改用備援模型時，前一個模型的部分文字仍在 content 內，只取最後一段
    parts: list[str] = []
    for block in message.content:
        if block.type == "fallback":
            parts.clear()
        elif block.type == "text":
            parts.append(block.text)
    return AIReply("".join(parts), message.model, message.stop_reason == "max_tokens")


def _call_openai(api_key: str, model: str, system: str, user: str) -> AIReply:
    import openai

    client = openai.OpenAI(
        api_key=api_key, timeout=AI_TIMEOUT_SECONDS, max_retries=AI_MAX_RETRIES,
    )
    response = None
    with _translate_errors("OpenAI", openai):
        stream = client.responses.create(
            model=model,
            instructions=system,
            input=user,
            reasoning={"effort": AI_EFFORT},
            max_output_tokens=AI_MAX_OUTPUT_TOKENS,
            store=False,  # 品管資料不留存在 OpenAI 的 Responses 紀錄
            stream=True,
        )
        for event in stream:
            if event.type in ("response.completed", "response.incomplete", "response.failed"):
                response = event.response

    if response is None or response.status == "failed":
        logger.warning("OpenAI response failed: %s", getattr(response, "error", None))
        raise HTTPException(status_code=502, detail="OpenAI 未能完成這次判讀，請稍後再試。")
    text = response.output_text
    if not text and response.status == "completed":
        raise HTTPException(status_code=422, detail="OpenAI 的安全機制拒絕了這次請求，請改用 Claude 或調整查詢範圍。")
    return AIReply(text, response.model, response.status == "incomplete")


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    key_env: str
    model: str
    call: Callable[[str, str, str, str], AIReply]


PROVIDERS = {
    "anthropic": Provider("anthropic", "Claude", "ANTHROPIC_API_KEY",
                          os.environ.get("AI_MODEL") or "claude-opus-5-5", _call_anthropic),
    "openai": Provider("openai", "OpenAI", "OPENAI_API_KEY",
                       os.environ.get("OPENAI_MODEL") or "gpt-6.1-sol", _call_openai),
}


def _ai_enabled() -> bool:
    """正式環境預設關閉，須明確設定 ENABLE_AI_INTERPRET=1 才會把資料送往外部。"""
    return os.environ.get("APP_ENV") != "production" or os.environ.get("ENABLE_AI_INTERPRET") == "1"


def _api_key(provider: Provider) -> str:
    return os.environ.get(provider.key_env, "").strip()


# ============================ API ============================ #
@router.get("/api/ai-providers", summary="可用的 AI 供應商")
def ai_providers():
    return {
        "enabled": _ai_enabled(),
        "providers": [
            {"id": p.id, "label": p.label, "model": p.model, "configured": bool(_api_key(p))}
            for p in PROVIDERS.values()
        ],
    }


@router.get("/api/ai-qc-data", summary="送給 AI 判讀的品管原始資料（JSON）")
def ai_qc_data(
    date_from: date = Query(..., description="起始日期 YYYY-MM-DD"),
    date_to: date | None = Query(None, description="結束日期，留空為不限"),
    section_name: str | None = Query(None),
    instrument_serial_number: str | None = Query(None),
    item_code: str | None = Query(None),
):
    return build_qc_payload(
        date_from=date_from, date_to=date_to, section_name=section_name,
        instrument_serial_number=instrument_serial_number, item_code=item_code,
    )


class AIInterpretIn(BaseModel):
    provider: Literal["anthropic", "openai"] | None = None
    section_name: str | None = None
    instrument_serial_number: str | None = None
    item_code: str | None = None
    date_from: date | None = None
    date_to: date | None = None


def _scope_text(query: dict) -> str:
    return (
        f"組別: {query['section_name'] or '全部'}｜"
        f"儀器: {query['instrument_serial_number'] or '全部'}｜"
        f"項目: {query['item_code'] or '全部'}｜"
        f"期間: {query['date_from']} ~ {query['date_to'] or '不限'}"
    )


@router.post("/api/ai-interpret", summary="AI 品管判讀")
def ai_interpret(req: AIInterpretIn):
    if not _ai_enabled():
        raise HTTPException(status_code=503, detail="正式環境尚未啟用 AI 判讀。")

    if req.provider:
        provider = PROVIDERS[req.provider]
    else:
        provider = next((p for p in PROVIDERS.values() if _api_key(p)), PROVIDERS["anthropic"])
    api_key = _api_key(provider)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"尚未設定 {provider.key_env}，請於 backend/.env 填入您自己的金鑰後重啟伺服器。",
        )
    if not req.date_from:
        raise HTTPException(status_code=422, detail="請選擇起始日期。")

    payload = build_qc_payload(
        date_from=req.date_from, date_to=req.date_to, section_name=req.section_name,
        instrument_serial_number=req.instrument_serial_number, item_code=req.item_code,
    )
    # 沒有原始資料就無從判讀，在此擋下，不呼叫 AI 也不產生費用；前端依 code 以彈窗告知
    if not payload["summary"]["record_count"]:
        raise HTTPException(status_code=404, detail={
            "code": "NO_QC_DATA",
            "message": "所選的項目目前無資料，無法判讀。",
            "scope": _scope_text(payload["query"]),
        })

    reply = provider.call(
        api_key, provider.model, GUIDE_PATH.read_text(encoding="utf-8"), _user_message(payload),
    )
    return {
        "provider": provider.id,
        "model": reply.model,
        "scope": _scope_text(payload["query"]),
        "record_count": payload["summary"]["record_count"],
        "truncated": payload["summary"]["truncated"],
        "max_records": payload["summary"]["max_records"],
        "incomplete": reply.incomplete,
        "interpretation": reply.text,
    }
