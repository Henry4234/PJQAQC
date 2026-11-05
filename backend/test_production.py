"""Checks the production login boundary without contacting Supabase or PostgreSQL."""
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient


HOST = "qaqc.example.com"
ORIGIN = f"https://{HOST}"
ORIGIN_HEADER = {"Origin": ORIGIN}
FORM = {"email": "operator@example.com", "password": "test-password"}


def check_login():
    from main import app
    from production import SESSION_COOKIE

    allowed = {"id": "user-1", "email_confirmed_at": "2026-01-01",
               "app_metadata": {"pjqaqc_access": True}}

    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as client, patch(
        "production.HTTPSConnection"
    ) as connection:
        def provider_response(status, user=None):
            connection.return_value.getresponse.return_value = SimpleNamespace(
                status=status, read=lambda _limit: json.dumps({"user": user}).encode(),
            )

        assert client.get("/").headers["location"] == "/login"
        assert client.get("/login").status_code == 200
        for path in ("/api/health", "/api/ready", "/api/instruments", "/api/ai-providers",
                     "/api/ai-qc-data?date_from=2026-01-01"):
            assert client.get(path).status_code == 401
        assert client.post("/login", data=FORM).status_code == 403
        assert client.get("/login", headers={"Host": "other.example.com"}).status_code == 404
        connection.assert_not_called()

        provider_response(200, {**allowed, "app_metadata": {},
                                "user_metadata": {"pjqaqc_access": True}})
        assert client.post("/login", data=FORM, headers=ORIGIN_HEADER).status_code == 401
        provider_response(200, {**allowed, "email_confirmed_at": None})
        assert client.post("/login", data=FORM, headers=ORIGIN_HEADER).status_code == 401
        provider_response(429)
        assert client.post("/login", data=FORM, headers=ORIGIN_HEADER).status_code == 429

        provider_response(200, allowed)
        response = client.post("/login", data=FORM, headers=ORIGIN_HEADER)
        assert response.status_code == 303 and response.headers["location"] == "/"
        assert connection.return_value.request.call_args.args[:2] == (
            "POST", "/auth/v1/token?grant_type=password",
        )
        cookie = response.headers["set-cookie"]
        assert all(flag in cookie for flag in (SESSION_COOKIE, "HttpOnly", "Secure", "Max-Age=1800"))
        assert client.get("/").status_code == 200
        assert client.get("/api/health").headers["cache-control"] == "private, no-store"
        assert client.get("/docs").status_code == 404
        assert client.post("/api/sections", json={}).status_code == 403
        assert client.post("/api/ai-interpret", json={}, headers=ORIGIN_HEADER).status_code == 503
        assert client.get("/api/ai-providers").json()["enabled"] is False
        assert client.post("/logout", headers=ORIGIN_HEADER).status_code == 303
        assert client.get("/api/health").status_code == 401

        client.cookies.set(SESSION_COOKIE, "forged-token")
        assert client.get("/api/health").status_code == 401


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        key_file = Path(directory, "session_key")
        key_file.write_text("a" * 64, encoding="utf-8")
        with patch.dict(os.environ, {
            "APP_ENV": "production", "PUBLIC_HOSTNAME": HOST,
            "SUPABASE_URL": "https://aaaaaaaaaaaaaaaaaaaa.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
            "SESSION_KEY_FILE": str(key_file), "ENABLE_AI_INTERPRET": "0",
            "DATABASE_URL": "postgresql://test@127.0.0.1/postgres?sslmode=verify-full",
        }):
            check_login()
    print("Production sign-in, permission check, CSRF, cookies and logout passed.")
