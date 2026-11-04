"""MariaDB 與 PostgreSQL 連線模組（v3）。

除基本查詢外，提供 `transaction()` 讓多表寫入具原子性——
v3 架構中平測、換批、品管執行、複製設定到備機都必須一次成功或一次失敗。
"""
from __future__ import annotations

import json
import os
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Generator

import pymysql
import pymysql.cursors
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if database_url_file := os.environ.get("DATABASE_URL_FILE"):
    if DATABASE_URL:
        raise RuntimeError("Set only one of DATABASE_URL and DATABASE_URL_FILE.")
    DATABASE_URL = Path(database_url_file).read_text(encoding="utf-8").strip()
POSTGRES = bool(DATABASE_URL)

if POSTGRES:
    import psycopg
    from psycopg.rows import dict_row

    DATABASE_ERRORS = (psycopg.Error,)
    DATA_ERRORS = (psycopg.DataError,)
    INTEGRITY_ERRORS = (psycopg.IntegrityError,)
else:
    DATABASE_ERRORS = (pymysql.Error,)
    DATA_ERRORS = (pymysql.DataError,)
    INTEGRITY_ERRORS = (pymysql.IntegrityError,)

NEXT_DAY = "(CAST(%s AS date) + 1)" if POSTGRES else "DATE_ADD(%s, INTERVAL 1 DAY)"
CASE_INSENSITIVE_MATCH = 'COLLATE "default" ILIKE' if POSTGRES else "LIKE"

_DB_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "127.0.0.1"),
    "port": int(os.environ.get("MYSQL_PORT") or "3306"),
    "user": os.environ.get("MYSQL_USER", ""),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
    "database": os.environ.get("MYSQL_DATABASE", ""),
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor,
}

# JSON 欄位：MariaDB 以字串回傳，需自行解析
_JSON_COLUMNS = {"westgard_flags"}


def new_id() -> str:
    """產生 UUID 主鍵。"""
    return str(uuid.uuid4())


@contextmanager
def get_conn() -> Generator[Any, None, None]:
    if POSTGRES:
        conn = psycopg.connect(
            DATABASE_URL, row_factory=dict_row, cursor_factory=psycopg.ClientCursor,
            connect_timeout=5,
        )
    else:
        conn = pymysql.connect(**_DB_CONFIG)
    try:
        if POSTGRES:
            with conn.cursor() as cur:
                cur.execute("SET search_path TO qaqc, pg_catalog")
                cur.execute("SET TIME ZONE 'Asia/Taipei'")
                cur.execute("SET statement_timeout TO '15s'")
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Generator[Any, None, None]:
    """多表寫入用；離開區塊時自動 commit，發生例外則 rollback。"""
    with get_conn() as conn:
        try:
            with conn.cursor() as cur:
                yield cur
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def _convert(value: Any, column: str = "") -> Any:
    """轉成可 JSON 序列化的型別。"""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, timedelta):  # TIME 欄位
        total = int(value.total_seconds())
        return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if column in _JSON_COLUMNS and isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value


def _convert_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: _convert(v, k) for k, v in row.items()}


def fetch_all(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return [_convert_row(r) for r in cur.fetchall()]


def fetch_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return _convert_row(cur.fetchone())


def execute(sql: str, params: tuple = ()) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()
            return cur.rowcount


# ---------------------------------------------------------------- 寫入輔助 --
def build_insert(table: str, data: dict[str, Any]) -> tuple[str, tuple]:
    """組出 INSERT 語句。表名與欄名皆為程式碼內字面值，值一律參數化。"""
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["%s"] * len(data))
    return f"INSERT INTO {table} ({cols}) VALUES ({placeholders})", tuple(data.values())


def tx_insert(cur: Any, table: str, data: dict[str, Any]) -> None:
    """在交易中插入一筆。"""
    sql, params = build_insert(table, data)
    cur.execute(sql, params)


def tx_insert_missing(cur: Any, table: str, data: dict[str, Any]) -> int:
    """複製 assay 關聯時，略過已存在的主鍵。"""
    sql, params = build_insert(table, data)
    if POSTGRES:
        sql += " ON CONFLICT DO NOTHING"
    else:
        sql = sql.replace("INSERT INTO", "INSERT IGNORE INTO", 1)
    cur.execute(sql, params)
    return cur.rowcount


def insert_one(table: str, data: dict[str, Any]) -> None:
    sql, params = build_insert(table, data)
    execute(sql, params)


def get_by_pk(table: str, pk_col: str, pk_val: Any) -> dict[str, Any] | None:
    return fetch_one(f"SELECT * FROM {table} WHERE {pk_col} = %s", (pk_val,))


def update_by_pk(table: str, pk_col: str, pk_val: Any, data: dict[str, Any]) -> None:
    if not data:
        return
    sets = ", ".join(f"{k} = %s" for k in data)
    execute(f"UPDATE {table} SET {sets} WHERE {pk_col} = %s", (*data.values(), pk_val))
