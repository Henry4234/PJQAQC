"""正式站的 Supabase Auth 登入、工作階段與來源檢查。"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from html import escape
from http.client import HTTPSConnection, HTTPException as HTTPClientError
from pathlib import Path
from urllib.parse import parse_qs

import jwt
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from psycopg.conninfo import conninfo_to_dict
from starlette.concurrency import run_in_threadpool

import database as db

SESSION_COOKIE = "__Host-pjqaqc_session"
SESSION_SECONDS = 1800
LOGIN_FORM_LIMIT = 4096


def _supabase_sign_in(hostname: str, key: str, email: str, password: str) -> tuple[int, str | None]:
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
    return 200, user_id


def configure_production(app: FastAPI) -> None:
    hostname = os.environ.get("PUBLIC_HOSTNAME", "").lower()
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
    key_file = os.environ.get("SESSION_KEY_FILE", "")
    secret_hex = Path(key_file).read_text(encoding="utf-8").strip() if key_file else ""

    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", hostname):
        raise RuntimeError("Set PUBLIC_HOSTNAME to the production DNS name.")
    if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", supabase_url):
        raise RuntimeError("Set SUPABASE_URL to the HTTPS project URL.")
    if not re.fullmatch(r"sb_publishable_[a-zA-Z0-9_-]+", key):
        raise RuntimeError("Set SUPABASE_PUBLISHABLE_KEY to a publishable key.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", secret_hex):
        raise RuntimeError("Set SESSION_KEY_FILE to a file containing 32 random bytes in hex.")
    if not db.DATABASE_URL or conninfo_to_dict(db.DATABASE_URL).get("sslmode") != "verify-full":
        raise RuntimeError("Set DATABASE_URL with sslmode=verify-full in production.")

    supabase_host = supabase_url.removeprefix("https://")
    signing_key = bytes.fromhex(secret_hex)
    login_template = Path(__file__).with_name("login.html").read_text(encoding="utf-8")
    issuer = "pjqaqc-session-v1"

    def login_page(status: int = 200, message: str = "") -> HTMLResponse:
        error = f'<p class="error" role="alert">{escape(message)}</p>' if message else ""
        return HTMLResponse(login_template.replace("<!-- login-error -->", error), status_code=status)

    def has_valid_session(token: str) -> bool:
        if not token or len(token) > 2048:
            return False
        try:
            jwt.decode(
                token, signing_key, algorithms=["HS256"], issuer=issuer, audience=hostname,
                options={"require": ["exp", "iat", "sub"]},
            )
        except jwt.PyJWTError:
            return False
        return True

    @app.get("/login", include_in_schema=False)
    def login() -> HTMLResponse:
        return login_page()

    @app.post("/login", include_in_schema=False)
    async def sign_in(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
            return login_page(415, "請使用登入表單。")
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > LOGIN_FORM_LIMIT:
                return login_page(413, "登入資料太長。")
            payload.extend(chunk)
        try:
            fields = parse_qs(payload.decode("utf-8"), strict_parsing=True, max_num_fields=2)
            email, password = fields["email"][0].strip(), fields["password"][0]
        except (ValueError, KeyError):
            return login_page(400, "請填寫電子郵件和密碼。")
        if not email or not password or len(email) > 254 or len(password) > 1024:
            return login_page(400, "請檢查電子郵件和密碼格式。")

        status, user_id = await run_in_threadpool(_supabase_sign_in, supabase_host, key, email, password)
        if status == 429:
            return login_page(status, "登入嘗試過多，請稍候再試。")
        if status == 503:
            return login_page(status, "目前無法連線至登入服務，請稍候再試。")
        if not user_id:
            return login_page(401, "電子郵件、密碼或帳號權限有誤。")

        now = datetime.now(timezone.utc)
        token = jwt.encode(
            {"sub": user_id, "iss": issuer, "aud": hostname, "iat": now,
             "exp": now + timedelta(seconds=SESSION_SECONDS)},
            signing_key, algorithm="HS256",
        )
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(
            SESSION_COOKIE, token, max_age=SESSION_SECONDS, path="/",
            secure=True, httponly=True, samesite="lax",
        )
        return response

    @app.post("/logout", include_in_schema=False)
    def logout():
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
        return response

    @app.middleware("http")
    async def protect_production(request: Request, call_next):
        path = request.url.path
        signed_in = has_valid_session(request.cookies.get(SESSION_COOKIE, ""))
        if request.headers.get("host", "").lower() != hostname:
            response = JSONResponse({"detail": "找不到此站台"}, status_code=404)
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and (
            request.headers.get("origin") != f"https://{hostname}"
        ):
            response = JSONResponse({"detail": "請從正式站送出操作"}, status_code=403)
        elif path == "/login" and signed_in:
            response = RedirectResponse("/", status_code=303)
        elif path == "/login" or signed_in:
            response = await call_next(request)
        elif path.startswith("/api/"):
            response = JSONResponse({"detail": "請登入後再試"}, status_code=401)
        else:
            response = RedirectResponse("/login", status_code=303)
        response.headers["X-PJQAQC-Auth"] = "required"
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        return response
