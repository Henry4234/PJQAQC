"""MySQL 資料庫連線模組。"""
from __future__ import annotations

import os
from contextlib import contextmanager
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


@contextmanager
def get_conn() -> Generator[pymysql.connections.Connection, None, None]:
    conn = pymysql.connect(**_DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()


def _convert_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """將 Decimal 轉為 float，讓 JSON 序列化正常運作。"""
    if row is None:
        return None
    return {k: float(v) if isinstance(v, Decimal) else v for k, v in row.items()}


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
            return cur.lastrowid


def insert_returning(table: str, data: dict[str, Any]) -> dict[str, Any]:
    """INSERT 一筆資料並回傳完整 row（透過 LAST_INSERT_ID 查回）。"""
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["%s"] * len(data))
    sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, tuple(data.values()))
            conn.commit()
            last_id = cur.lastrowid
            cur.execute(f"SELECT * FROM {table} WHERE id = %s", (last_id,))
            return _convert_row(cur.fetchone())
