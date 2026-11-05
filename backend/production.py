"""正式環境的編輯者驗證。

帳號與密碼由 Supabase Auth 管理；驗證通過且具 `app_metadata.pjqaqc_access` 的帳號，
由此處簽發 30 分鐘的 HttpOnly 工作階段 cookie。

此服務只接受帶共用密鑰的 Cloudflare Worker 請求。未登入者不能讀寫任何資料——
DEMO 模式完全在瀏覽器內執行，不會呼叫這裡。
"""
from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime, timedelta, timezone
from http.client import HTTPSConnection, HTTPException as HTTPClientError
from pathlib import Path

import jwt
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg.conninfo import conninfo_to_dict
from starlette.concurrency import run_in_threadpool

import database as db

SESSION_COOKIE = "__Host-pjqaqc_session"
SESSION_SECONDS = 1800
LOGIN_BODY_LIMIT = 4096
EDGE_HEADER = "x-pjqaqc-edge"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
AUTH_PATHS = {"/api/auth/login", "/api/auth/logout", "/api/auth/session"}


def _supabase_sign_in(hostname: str, key: str, email: str, password: str) -> tuple[int, dict | None]:
    conn = HTTPSConnection(hostname, timeout=8)
    try:
        conn.request(
            "POST", "/auth/v1/token?grant_type=password",
            body=json.dumps({"email": email, "password": password}),
            headers={"apikey": key, "Content-Type": "application/json"},
        )
        response = conn.getresponse()
        if response.status in {400, 401, 403, 422}:
            return 401, None
        if response.status == 429:
            return 429, None
        if response.status != 200:
            return 503, None
        payload = json.loads(response.read(65536))
    except (OSError, HTTPClientError, ValueError):
        return 503, None
    finally:
        conn.close()

    user = payload.get("user") if isinstance(payload, dict) else None
    if not isinstance(user, dict):
        return 503, None
    metadata = user.get("app_metadata")
    user_id = user.get("id")
    if (
        not isinstance(user_id, str) or not user_id
        or not user.get("email_confirmed_at")
        or not isinstance(metadata, dict) or metadata.get("pjqaqc_access") is not True
    ):
        return 401, None
    return 200, {"id": user_id, "email": user.get("email") or email}


def _read_secret_file(variable: str) -> str:
    path = os.environ.get(variable, "")
    return Path(path).read_text(encoding="utf-8").strip() if path else ""


def _login_error(status: int) -> JSONResponse:
    detail = {
        400: "請填寫正確的電子郵件和密碼。",
        401: "電子郵件、密碼或帳號權限有誤。",
        413: "登入資料太長。",
        415: "請使用登入表單。",
        429: "登入嘗試過多，請稍候再試。",
        503: "目前無法連線至登入服務，請稍候再試。",
    }[status]
    return JSONResponse({"detail": detail}, status_code=status)


def configure_production(app: FastAPI) -> None:
    hostname = os.environ.get("PUBLIC_HOSTNAME", "").lower()
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
    secret_hex = _read_secret_file("SESSION_KEY_FILE")
    edge_secret = _read_secret_file("EDGE_SECRET_FILE").encode()

    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", hostname):
        raise RuntimeError("Set PUBLIC_HOSTNAME to the portal DNS name.")
    if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", supabase_url):
        raise RuntimeError("Set SUPABASE_URL to the HTTPS project URL.")
    if not re.fullmatch(r"sb_publishable_[a-zA-Z0-9_-]+", key):
        raise RuntimeError("Set SUPABASE_PUBLISHABLE_KEY to a publishable key.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", secret_hex):
        raise RuntimeError("Set SESSION_KEY_FILE to a file containing 32 random bytes in hex.")
    if len(edge_secret) < 32:
        raise RuntimeError("Set EDGE_SECRET_FILE to a file containing at least 32 random characters.")
    if not db.DATABASE_URL or conninfo_to_dict(db.DATABASE_URL).get("sslmode") != "verify-full":
        raise RuntimeError("Set DATABASE_URL with sslmode=verify-full in production.")

    supabase_host = supabase_url.removeprefix("https://")
    signing_key = bytes.fromhex(secret_hex)
    issuer = "pjqaqc-session-v1"
    portal_origin = f"https://{hostname}"

    def read_session(token: str) -> dict | None:
        if not token or len(token) > 2048:
            return None
        try:
            return jwt.decode(
                token, signing_key, algorithms=["HS256"], issuer=issuer, audience=hostname,
                options={"require": ["exp", "iat", "sub"]},
            )
        except jwt.PyJWTError:
            return None

    @app.get("/api/auth/session", include_in_schema=False)
    def session(request: Request) -> dict:
        claims = read_session(request.cookies.get(SESSION_COOKIE, ""))
        return {"authenticated": bool(claims), "email": claims.get("email") if claims else None}

    @app.post("/api/auth/login", include_in_schema=False)
    async def sign_in(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
            return _login_error(415)
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > LOGIN_BODY_LIMIT:
                return _login_error(413)
            payload.extend(chunk)
        try:
            fields = json.loads(payload)
            email, password = fields["email"], fields["password"]
        except (ValueError, KeyError, TypeError):
            return _login_error(400)
        if not isinstance(email, str) or not isinstance(password, str):
            return _login_error(400)
        email = email.strip()
        if not email or not password or len(email) > 254 or len(password) > 1024:
            return _login_error(400)

        status, user = await run_in_threadpool(_supabase_sign_in, supabase_host, key, email, password)
        if status != 200 or not user:
            return _login_error(status)

        now = datetime.now(timezone.utc)
        token = jwt.encode(
            {"sub": user["id"], "email": user["email"], "iss": issuer, "aud": hostname, "iat": now,
             "exp": now + timedelta(seconds=SESSION_SECONDS)},
            signing_key, algorithm="HS256",
        )
        response = JSONResponse({"authenticated": True, "email": user["email"]})
        response.set_cookie(
            SESSION_COOKIE, token, max_age=SESSION_SECONDS, path="/",
            secure=True, httponly=True, samesite="lax",
        )
        return response

    @app.post("/api/auth/logout", include_in_schema=False)
    def sign_out():
        response = JSONResponse({"authenticated": False})
        response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
        return response

    @app.middleware("http")
    async def protect_production(request: Request, call_next):
        supplied_secret = request.headers.get(EDGE_HEADER, "").encode()
        if not hmac.compare_digest(supplied_secret, edge_secret):
            response = JSONResponse({"detail": "找不到此站台"}, status_code=404)
        elif request.method not in SAFE_METHODS and request.headers.get("origin") != portal_origin:
            response = JSONResponse({"detail": "請從本站送出操作"}, status_code=403)
        elif request.url.path in AUTH_PATHS or read_session(request.cookies.get(SESSION_COOKIE, "")):
            response = await call_next(request)
        else:
            response = JSONResponse({"detail": "請先登入編輯者帳號"}, status_code=401)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        return response
