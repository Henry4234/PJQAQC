"""MariaDB 連線模組（v3）。

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
from typing import Any, Generator

import pymysql
import pymysql.cursors
from dotenv import load_dotenv

load_dotenv()

_DB_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "127.0.0.1"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
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
def get_conn() -> Generator[pymysql.connections.Connection, None, None]:
    conn = pymysql.connect(**_DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Generator[pymysql.cursors.DictCursor, None, None]:
    """多表寫入用；離開區塊時自動 commit，發生例外則 rollback。"""
    conn = pymysql.connect(**_DB_CONFIG)
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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


def tx_insert(cur: pymysql.cursors.DictCursor, table: str, data: dict[str, Any]) -> None:
    """在交易中插入一筆。"""
    sql, params = build_insert(table, data)
    cur.execute(sql, params)


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
