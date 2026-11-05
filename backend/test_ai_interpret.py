"""Checks the AI QC data and provider boundary with no database, network, or real API key."""
import json
import logging
import os
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import anthropic
import httpx2
import openai
from fastapi.testclient import TestClient


FAKE_ANTHROPIC_KEY = "fake-anthropic-key-for-tests"
FAKE_OPENAI_KEY = "fake-openai-key-for-tests"
BODY = {"date_from": "2026-10-01", "date_to": "2026-10-31"}


def row(run_at, z, *, lot="LOT-A", level="L1", status="PASS", flags=None, mean=100.0, note=None):
    return {
        "run_at": run_at, "section_name": "生化組", "serial_number": "SN-1",
        "instrument_name": "Demo Analyzer", "instrument_role": "PRIMARY",
        "item_code": "GLU", "item_name": "Glucose", "specimen_code": "S", "specimen_name": "Serum",
        "qc_product_name": "Demo QC", "qc_lot_number": lot, "qc_level": level,
        "result_value": mean + z * 2, "unit_snapshot": "mg/dL",
        "target_mean_snapshot": mean, "target_sd_snapshot": 2.0, "z_score": z,
        "result_status": status, "westgard_flags": flags, "note": note,
    }


# 資料庫依 run_at 由新到舊回傳
ROWS = [
    row("2026-10-03T08:00:00", 3.5, status="FAIL", flags=["1-3s"], mean=101.0, note="重跑"),
    row("2026-10-02T08:00:00", 2.5, status="WARNING", flags=["1-2s"]),
    row("2026-10-01T08:00:00", 0.1),
    row("2026-10-01T08:00:00", -0.2, lot="LOT-B", level="L2"),
]


def provider_stub(ai_interpret, name, reply=None):
    call = MagicMock(return_value=reply or ai_interpret.AIReply("判讀內容", "served-model", False))
    return call, patch.dict(ai_interpret.PROVIDERS, {name: replace(ai_interpret.PROVIDERS[name], call=call)})


def check_data_api(client, ai_interpret):
    with patch.object(ai_interpret.db, "fetch_all", return_value=[dict(r) for r in ROWS]) as fetch:
        response = client.get("/api/ai-qc-data", params={
            **BODY, "section_name": "生化組", "instrument_serial_number": "SN-1", "item_code": "GLU",
        })
    assert response.status_code == 200, response.text
    sql, params = fetch.call_args.args
    assert "section_name = %s" in sql and "serial_number = %s" in sql and "item_code = %s" in sql
    assert params[0] == "2026-10-01 00:00:00" and params[1] == "2026-10-31"
    assert params[-1] == ai_interpret.AI_MAX_RECORDS + 1
    assert "operator" not in sql and "reviewed" not in sql, "人員欄位不可送往外部 AI"

    data = response.json()
    assert data["schema_version"] == ai_interpret.SCHEMA_VERSION
    assert data["query"]["item_code"] == "GLU"
    summary = data["summary"]
    assert summary["record_count"] == 4 and summary["series_count"] == 2 and not summary["truncated"]
    assert summary["status_counts"] == {"PASS": 2, "WARNING": 1, "FAIL": 1, "INVALID": 0}
    assert summary["rule_counts"] == {"1-2s": 1, "1-3s": 1}
    assert summary["first_run_at"] == "2026-10-01T08:00:00"
    assert summary["last_run_at"] == "2026-10-03T08:00:00"

    # 目標值改版不切斷序列，因為系統計算 Westgard 時也不切斷
    lot_a = next(s for s in data["series"] if s["qc_lot_number"] == "LOT-A")
    assert [r["run_at"][:10] for r in lot_a["results"]] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert [r["mean"] for r in lot_a["results"]] == [100.0, 100.0, 101.0]
    assert lot_a["results"][0]["westgard_flags"] == []
    assert lot_a["results"][2]["westgard_flags"] == ["1-3s"]
    assert lot_a["results"][2]["note"] == "重跑"

    # 超過上限時保留最新資料並明確標示
    many = [row(f"2026-10-{(i % 28) + 1:02d}T08:00:00", 0.0) for i in range(ai_interpret.AI_MAX_RECORDS + 1)]
    with patch.object(ai_interpret.db, "fetch_all", return_value=many):
        summary = client.get("/api/ai-qc-data", params=BODY).json()["summary"]
    assert summary["truncated"] and summary["record_count"] == ai_interpret.AI_MAX_RECORDS

    with patch.object(ai_interpret.db, "fetch_all", return_value=[]) as fetch:
        assert client.get("/api/ai-qc-data").status_code == 422
        assert client.get("/api/ai-qc-data", params={"date_from": "not-a-date"}).status_code == 422
        assert client.get("/api/ai-qc-data", params={
            "date_from": "2026-10-31", "date_to": "2026-10-01"}).status_code == 422
        fetch.assert_not_called()
        empty = client.get("/api/ai-qc-data", params={"date_from": "2026-10-01"})
    assert empty.status_code == 200 and empty.json()["series"] == []


def check_providers_and_interpret(client, ai_interpret):
    info = client.get("/api/ai-providers")
    assert info.status_code == 200
    assert {p["id"]: p["configured"] for p in info.json()["providers"]} == {"anthropic": True, "openai": True}
    assert FAKE_ANTHROPIC_KEY not in info.text and FAKE_OPENAI_KEY not in info.text

    call, stub = provider_stub(ai_interpret, "openai")
    with stub, patch.object(ai_interpret.db, "fetch_all", return_value=[dict(r) for r in ROWS]):
        response = client.post("/api/ai-interpret", json={**BODY, "provider": "openai", "item_code": "GLU"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["model"] == "served-model" and result["record_count"] == 4
    assert result["interpretation"] == "判讀內容" and "項目: GLU" in result["scope"]
    key, _model, system, user = call.call_args.args
    assert key == FAKE_OPENAI_KEY and "判讀指引" in system
    sent = json.loads(user.split("<qc_data>\n")[1].split("\n</qc_data>")[0])
    assert sent["summary"]["record_count"] == 4 and sent["series"][0]["results"]

    # 查無資料時不呼叫付費 API，並回傳前端彈窗需要的代碼、訊息與查詢條件
    for name in ai_interpret.PROVIDERS:
        call, stub = provider_stub(ai_interpret, name)
        with stub, patch.object(ai_interpret.db, "fetch_all", return_value=[]):
            empty = client.post("/api/ai-interpret", json={**BODY, "provider": name, "item_code": "GLU"})
        assert empty.status_code == 404
        detail = empty.json()["detail"]
        assert detail["code"] == "NO_QC_DATA"
        assert detail["message"] == "所選的項目目前無資料，無法判讀。"
        assert "項目: GLU" in detail["scope"] and "2026-10-01 ~ 2026-10-31" in detail["scope"]
        call.assert_not_called()

    # 只設定一把金鑰時自動選用；指定未設定的供應商則回報要設定哪個變數
    call, stub = provider_stub(ai_interpret, "openai")
    with stub, patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}), patch.object(
        ai_interpret.db, "fetch_all", return_value=[dict(r) for r in ROWS],
    ):
        assert client.post("/api/ai-interpret", json=BODY).json()["provider"] == "openai"
        missing = client.post("/api/ai-interpret", json={**BODY, "provider": "anthropic"})
        assert missing.status_code == 400 and "ANTHROPIC_API_KEY" in missing.text
    assert client.post("/api/ai-interpret", json={**BODY, "provider": "other"}).status_code == 422
    assert client.post("/api/ai-interpret", json={"provider": "openai"}).status_code == 422

    # 正式環境未明確啟用時，即使有金鑰也不送出
    with patch.dict(os.environ, {"APP_ENV": "production", "ENABLE_AI_INTERPRET": "0"}):
        assert client.post("/api/ai-interpret", json=BODY).status_code == 503
        assert client.get("/api/ai-providers").json()["enabled"] is False


def check_errors_never_expose_keys(ai_interpret):
    from fastapi import HTTPException

    records = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Capture()
    ai_interpret.logger.addHandler(handler)
    request = httpx2.Request("POST", "https://api.example.test")
    for sdk, label, key in ((anthropic, "Claude", FAKE_ANTHROPIC_KEY), (openai, "OpenAI", FAKE_OPENAI_KEY)):
        cases = [
            (sdk.AuthenticationError(f"Incorrect API key: {key}", response=httpx2.Response(401, request=request), body=None), 502),
            (sdk.RateLimitError("rate limit exceeded", response=httpx2.Response(429, request=request), body=None), 502),
            (sdk.InternalServerError("oops", response=httpx2.Response(500, request=request), body=None), 502),
            (sdk.APIConnectionError(message=f"down {key}", request=request), 502),
            (sdk.APITimeoutError(request=request), 504),
        ]
        for error, expected in cases:
            try:
                with ai_interpret._translate_errors(label, sdk):
                    raise error
            except HTTPException as e:
                assert e.status_code == expected
                assert key not in e.detail
                assert e.__suppress_context__ and label in e.detail
            else:
                raise AssertionError("SDK 例外應轉成 HTTPException")
    ai_interpret.logger.removeHandler(handler)
    assert records and not any("-for-tests" in message for message in records)


class FakeAnthropicStream:
    def __init__(self, message):
        self.message = message

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def get_final_message(self):
        return self.message


def check_claude_call(ai_interpret):
    def run(message, model="claude-opus-5-5"):
        with patch("anthropic.Anthropic") as cls:
            cls.return_value.beta.messages.stream.return_value = FakeAnthropicStream(message)
            reply = ai_interpret._call_anthropic("key", model, "system", "user")
        return reply, cls.return_value.beta.messages.stream.call_args.kwargs

    text = lambda value: SimpleNamespace(type="text", text=value)
    thinking = SimpleNamespace(type="thinking", thinking="")
    switch = SimpleNamespace(type="fallback")

    # 串流中途改用備援模型時，只保留最後一段
    reply, kwargs = run(SimpleNamespace(
        stop_reason="end_turn", model="claude-opus-5",
        content=[thinking, text("declined partial"), switch, thinking, text("完整"), text("判讀")],
    ))
    assert reply.text == "完整判讀" and reply.model == "claude-opus-5" and not reply.incomplete
    assert kwargs["fallbacks"] == "default" and kwargs["betas"] == [ai_interpret.ANTHROPIC_FALLBACK_BETA]
    assert kwargs["output_config"] == {"effort": ai_interpret.AI_EFFORT}
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert not {"temperature", "top_p", "top_k"} & kwargs.keys()

    reply, kwargs = run(
        SimpleNamespace(stop_reason="max_tokens", model="claude-haiku-5-5", content=[text("部分")]),
        model="claude-haiku-5-5",
    )
    assert reply.incomplete and "fallbacks" not in kwargs and "betas" not in kwargs

    from fastapi import HTTPException
    try:
        run(SimpleNamespace(stop_reason="refusal", model="claude-opus-5-5", content=[]))
    except HTTPException as e:
        assert e.status_code == 422
    else:
        raise AssertionError("refusal 應回報錯誤")


def check_openai_call(ai_interpret):
    from fastapi import HTTPException

    def run(*events):
        with patch("openai.OpenAI") as cls:
            cls.return_value.responses.create.return_value = iter(events)
            reply = ai_interpret._call_openai("key", "gpt-test", "system", "user")
        return reply, cls.return_value.responses.create.call_args.kwargs

    def final(status, output_text):
        return SimpleNamespace(type=f"response.{status}", response=SimpleNamespace(
            status=status, output_text=output_text, model="gpt-served", error=None,
        ))

    delta = SimpleNamespace(type="response.output_text.delta")
    reply, kwargs = run(delta, final("completed", "判讀"))
    assert reply.text == "判讀" and reply.model == "gpt-served" and not reply.incomplete
    assert kwargs["store"] is False and kwargs["instructions"] == "system" and kwargs["input"] == "user"
    assert kwargs["reasoning"] == {"effort": ai_interpret.AI_EFFORT} and kwargs["stream"] is True

    reply, _ = run(delta, final("incomplete", "部分"))
    assert reply.incomplete and reply.text == "部分"

    for events, expected in (((final("failed", ""),), 502), ((delta,), 502), ((final("completed", ""),), 422)):
        try:
            run(*events)
        except HTTPException as e:
            assert e.status_code == expected
        else:
            raise AssertionError("未完成的回覆應回報錯誤")


if __name__ == "__main__":
    with patch.dict(os.environ, {
        "ANTHROPIC_API_KEY": FAKE_ANTHROPIC_KEY, "OPENAI_API_KEY": FAKE_OPENAI_KEY,
    }):
        os.environ.pop("APP_ENV", None)
        import ai_interpret as module
        from main import app

        with TestClient(app) as test_client:
            check_data_api(test_client, module)
            check_providers_and_interpret(test_client, module)
        check_errors_never_expose_keys(module)
        check_claude_call(module)
        check_openai_call(module)
    print("AI QC data, provider selection, production gate and key handling passed.")
