FROM ghcr.io/astral-sh/uv:0.13.7 AS uv
FROM python:3.13-slim-bookworm

WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TZ=Asia/Taipei
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=from=uv,source=/uv,target=/bin/uv uv sync --locked --no-dev --no-install-project

COPY backend/*.py backend/westgard_guide.md ./
COPY frontend/index.html frontend/style.css frontend/app.js /app/frontend/

USER 10001:10001
CMD ["/app/backend/.venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log", "--limit-concurrency", "32"]
