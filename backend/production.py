"""正式站的 Cloudflare Access 驗證與瀏覽器來源檢查。"""
from __future__ import annotations

import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool


def configure_production(app: FastAPI) -> None:
    import jwt
    from psycopg.conninfo import conninfo_to_dict

    import database as db

    hostname = os.environ.get("PUBLIC_HOSTNAME", "").lower()
    team = os.environ.get("CF_ACCESS_TEAM", "")
    audience = os.environ.get("CF_ACCESS_AUD", "")
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", hostname):
        raise RuntimeError("Set PUBLIC_HOSTNAME to the production DNS name.")
    if not re.fullmatch(r"[a-z0-9-]+", team) or not re.fullmatch(r"[a-f0-9]{64}", audience):
        raise RuntimeError("Set CF_ACCESS_TEAM and CF_ACCESS_AUD from the Access application.")
    if not db.DATABASE_URL or conninfo_to_dict(db.DATABASE_URL).get("sslmode") != "verify-full":
        raise RuntimeError("Set DATABASE_URL with sslmode=verify-full in production.")

    issuer = f"https://{team}.cloudflareaccess.com"
    jwks = jwt.PyJWKClient(f"{issuer}/cdn-cgi/access/certs", timeout=5)

    def has_valid_token(token: str) -> bool:
        try:
            key = jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token, key.key, algorithms=["RS256"], issuer=issuer, audience=audience,
                options={"require": ["exp", "iat", "sub", "email"]},
            )
        except (jwt.PyJWTError, ValueError):
            return False
        return claims.get("type") == "app" and bool(claims["email"])

    @app.middleware("http")
    async def protect_production(request: Request, call_next):
        token = request.headers.get("cf-access-jwt-assertion", "")
        if request.headers.get("host", "").lower() != hostname:
            response = JSONResponse({"detail": "找不到此站台"}, status_code=404)
        elif not token or len(token) > 8192 or not await run_in_threadpool(has_valid_token, token):
            response = JSONResponse({"detail": "需要有效的 Cloudflare Access 登入"}, status_code=401)
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and (
            request.headers.get("origin") != f"https://{hostname}"
        ):
            response = JSONResponse({"detail": "請從正式站送出操作"}, status_code=403)
        else:
            response = await call_next(request)
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
