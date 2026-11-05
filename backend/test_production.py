"""Checks the production editor boundary without contacting Supabase or PostgreSQL."""
import json
import os
import re
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient


HOST = "qaqc.example.com"
ORIGIN = f"https://{HOST}"
EDGE_SECRET = "e" * 40
EDGE = {"X-PJQAQC-Edge": EDGE_SECRET}
WRITE = {**EDGE, "Origin": ORIGIN}
CREDENTIALS = {"email": "editor@example.com", "password": "test-password"}
AUTH_PATHS = {"/api/auth/login", "/api/auth/logout", "/api/auth/session"}
ALLOWED_USER = {"id": "user-1", "email": "editor@example.com", "email_confirmed_at": "2026-01-01",
                "app_metadata": {"pjqaqc_access": True}}


def check_every_data_route_requires_a_session(app, client):
    """A new route must not be able to skip the boundary by accident."""
    import manage
    import register

    data_routes = [
        route for routes in (app.routes, register.router.routes, manage.router.routes)
        for route in routes if isinstance(route, APIRoute) and route.path not in AUTH_PATHS
    ]
    assert len(data_routes) > 40
    for route in data_routes:
        path = re.sub(r"\{[^}]+\}", "1", route.path)
        for method in route.methods - {"HEAD", "OPTIONS"}:
            status = client.request(method, path, headers=WRITE, json={}).status_code
            assert status == 401, f"{method} {path} returned {status} without a session"


def check_boundary():
    from main import app
    from production import SESSION_COOKIE

    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as client, patch(
        "production.HTTPSConnection"
    ) as connection:
        def provider_response(status, user=None):
            connection.return_value.getresponse.return_value = SimpleNamespace(
                status=status, read=lambda _limit: json.dumps({"user": user}).encode(),
            )

        def login(payload=CREDENTIALS):
            return client.post("/api/auth/login", json=payload, headers=WRITE)

        # Only the Worker can reach the service.
        assert client.get("/api/auth/session").status_code == 404
        assert client.get("/api/health", headers={"X-PJQAQC-Edge": "wrong"}).status_code == 404
        assert client.post("/api/auth/login", json=CREDENTIALS).status_code == 404

        # Anonymous requests see nothing.
        assert client.get("/api/auth/session", headers=EDGE).json() == {"authenticated": False, "email": None}
        assert client.get("/", headers=EDGE).status_code == 401
        for path in ("/api/health", "/api/ready", "/api/instruments", "/api/qc-results"):
            assert client.get(path, headers=EDGE).status_code == 401
        check_every_data_route_requires_a_session(app, client)

        # Malformed sign-ins and cross-origin writes never reach Supabase.
        assert client.post("/api/auth/login", json=CREDENTIALS, headers=EDGE).status_code == 403
        assert client.post("/api/auth/login", data="email=a", headers={
            **WRITE, "Content-Type": "application/x-www-form-urlencoded"}).status_code == 415
        assert client.post("/api/auth/login", content="{", headers={
            **WRITE, "Content-Type": "application/json"}).status_code == 400
        assert login({"email": ["a"], "password": "b"}).status_code == 400
        assert login({"email": "a@example.com"}).status_code == 400
        assert client.post("/api/auth/login", content="x" * 5000, headers={
            **WRITE, "Content-Type": "application/json"}).status_code == 413
        connection.assert_not_called()

        # Supabase decides who is an editor; user-editable metadata does not count.
        provider_response(200, {**ALLOWED_USER, "app_metadata": {},
                                "user_metadata": {"pjqaqc_access": True}})
        assert login().status_code == 401
        provider_response(200, {**ALLOWED_USER, "email_confirmed_at": None})
        assert login().status_code == 401
        provider_response(400)
        assert login().status_code == 401
        provider_response(429)
        assert login().status_code == 429
        provider_response(500)
        assert login().status_code == 503
        assert SESSION_COOKIE not in client.cookies

        # An authorized editor gets a hardened session cookie.
        provider_response(200, ALLOWED_USER)
        response = login()
        assert response.status_code == 200
        assert response.json() == {"authenticated": True, "email": "editor@example.com"}
        assert connection.return_value.request.call_args.args[:2] == (
            "POST", "/auth/v1/token?grant_type=password",
        )
        cookie = response.headers["set-cookie"]
        assert all(flag in cookie for flag in (SESSION_COOKIE, "HttpOnly", "Secure", "Max-Age=1800", "SameSite=lax"))
        assert client.get("/api/auth/session", headers=EDGE).json() == {
            "authenticated": True, "email": "editor@example.com",
        }
        health = client.get("/api/health", headers=EDGE)
        assert health.status_code == 200 and health.headers["cache-control"] == "private, no-store"
        assert client.get("/docs", headers=EDGE).status_code == 404
        assert client.get("/", headers=EDGE).status_code == 404, "the portal is served by the Worker"

        # A session does not excuse a missing Origin or the edge secret.
        assert client.post("/api/sections", json={}, headers=EDGE).status_code == 403
        assert client.get("/api/health").status_code == 404
        assert client.post("/api/ai-interpret", json={}, headers=WRITE).status_code == 503

        # Logging out ends the session; forged tokens are rejected.
        assert client.post("/api/auth/logout", headers=WRITE).status_code == 200
        assert client.get("/api/health", headers=EDGE).status_code == 401
        client.cookies.set(SESSION_COOKIE, "forged-token")
        assert client.get("/api/health", headers=EDGE).status_code == 401


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        key_file = Path(directory, "session_key")
        key_file.write_text("a" * 64, encoding="utf-8")
        edge_file = Path(directory, "edge_secret")
        edge_file.write_text(EDGE_SECRET, encoding="utf-8")
        with patch.dict(os.environ, {
            "APP_ENV": "production", "PUBLIC_HOSTNAME": HOST,
            "SUPABASE_URL": "https://aaaaaaaaaaaaaaaaaaaa.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
            "SESSION_KEY_FILE": str(key_file), "EDGE_SECRET_FILE": str(edge_file),
            "ENABLE_AI_INTERPRET": "0",
            "DATABASE_URL": "postgresql://test@127.0.0.1/postgres?sslmode=verify-full",
        }):
            check_boundary()
    print("Editor sign-in, permission check, edge secret, CSRF, cookies and logout passed.")
