"""管理（manage）相關 API：修改與移除主檔。

與 register.py（新增）分工，集中管理：
  - 檢驗項目 items
  - 試劑     reagent（含可操作檢體類別的重新設定）
  - 品管液   reagent_qc

刪除策略：
  優先嘗試實際刪除；若該筆已被其他資料引用（例如品管液已有品管紀錄，
  qc_records.reagent_qc_id 為 FK 且不串聯刪除），則回 409 並建議改用「停用」。
  停用 = PATCH active=false，可保留歷史關聯與稽核軌跡。
"""
from __future__ import annotations

from typing import Any

import pymysql
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import database as db

router = APIRouter(prefix="/api", tags=["manage"])

# 各資源對應的資料表與主鍵欄位（皆為程式碼字面值，非使用者輸入）
_RESOURCES = {
    "items": ("items", "item_id"),
    "reagent": ("reagent", "reagent_id"),
    "reagent_qc": ("reagent_qc", "reagent_qc_id"),
}


# ============================ 共用工具 ============================ #
def _get_row(resource: str, pk: str) -> dict:
    table, pk_col = _RESOURCES[resource]
    row = db.fetch_one(f"SELECT * FROM {table} WHERE {pk_col} = %s", (pk,))
    if not row:
        raise HTTPException(status_code=404, detail=f"查無資料：{pk}")
    return row


def _update_row(resource: str, pk: str, data: dict[str, Any]) -> dict:
    """以 PATCH 語意更新（只更新有給的欄位），回傳更新後的完整資料列。"""
    table, pk_col = _RESOURCES[resource]
    _get_row(resource, pk)  # 不存在則 404
    if not data:
        return _get_row(resource, pk)

    sets = ", ".join(f"{k} = %s" for k in data.keys())
    sql = f"UPDATE {table} SET {sets} WHERE {pk_col} = %s"
    try:
        db.execute(sql, (*data.values(), pk))
    except pymysql.err.IntegrityError as e:
        msg = e.args[1] if len(e.args) > 1 else str(e)
        raise HTTPException(status_code=409, detail=f"更新失敗（重複鍵或關聯不存在）：{msg}")
    return _get_row(resource, pk)


def _delete_row(resource: str, pk: str, in_use_hint: str) -> dict:
    table, pk_col = _RESOURCES[resource]
    _get_row(resource, pk)
    try:
        db.execute(f"DELETE FROM {table} WHERE {pk_col} = %s", (pk,))
    except pymysql.err.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail=f"無法刪除：{in_use_hint}。建議改用「停用」保留歷史資料。",
        )
    return {"deleted": True, "id": pk}


# ============================ 1. 檢驗項目 items ============================ #
class ItemUpdate(BaseModel):
    item_code: str | None = None
    item_name: str | None = None
    unit: str | None = None
    sort_order: int | None = None
    active: bool | None = None
    remark: str | None = None


@router.patch("/items/{item_id}", summary="修改檢驗項目")
def update_item(item_id: str, inp: ItemUpdate):
    return _update_row("items", item_id, inp.model_dump(exclude_unset=True))


@router.delete("/items/{item_id}", summary="刪除檢驗項目")
def delete_item(item_id: str):
    return _delete_row("items", item_id, "此項目仍被其他資料引用")


# ============================ 2. 試劑 reagent ============================ #
class ReagentUpdate(BaseModel):
    test_item: str | None = None
    reagent_name: str | None = None
    lot_number: str | None = None
    manufacturer: str | None = None
    in_stock: bool | None = None
    in_stock_date: str | None = None
    parallel_test_done: bool | None = None
    parallel_test_date: str | None = None
    same_lot_as_previous: bool | None = None
    previous_lot_number: str | None = None
    expiry_date: str | None = None
    active: bool | None = None
    remark: str | None = None
    specimen_type_codes: list[str] | None = Field(
        None, description="若提供則整組覆寫此試劑可操作的檢體類別"
    )


@router.patch("/reagents/{reagent_id}", summary="修改試劑")
def update_reagent(reagent_id: str, inp: ReagentUpdate):
    data = inp.model_dump(exclude_unset=True)
    codes = data.pop("specimen_type_codes", None)

    if codes is not None:
        # 先驗證全部代碼有效，再整組覆寫關聯
        ids = []
        for c in codes:
            row = db.fetch_one(
                "SELECT specimen_type_id FROM specimen_type WHERE code = %s AND active = TRUE", (c,)
            )
            if not row:
                raise HTTPException(status_code=400, detail=f"檢體代碼不存在：{c}")
            ids.append(row["specimen_type_id"])
        _get_row("reagent", reagent_id)
        db.execute("DELETE FROM reagent_specimen_map WHERE reagent_id = %s", (reagent_id,))
        for sid in ids:
            db.execute(
                "INSERT INTO reagent_specimen_map (reagent_id, specimen_type_id) VALUES (%s, %s)",
                (reagent_id, sid),
            )

    row = _update_row("reagent", reagent_id, data)
    row["specimen_type_codes"] = [
        r["code"]
        for r in db.fetch_all(
            "SELECT s.code FROM reagent_specimen_map m "
            "JOIN specimen_type s ON s.specimen_type_id = m.specimen_type_id "
            "WHERE m.reagent_id = %s ORDER BY s.code",
            (reagent_id,),
        )
    ]
    return row


@router.delete("/reagents/{reagent_id}", summary="刪除試劑")
def delete_reagent(reagent_id: str):
    return _delete_row("reagent", reagent_id, "此試劑仍被其他資料引用")


# ============================ 3. 品管液 reagent_qc ============================ #
class ReagentQCUpdate(BaseModel):
    specimen_type_code: str | None = None
    test_item: str | None = None
    test_item_full_name: str | None = None
    qc_level: str | None = None
    qc_lot_number: str | None = None
    unit: str | None = None
    manufacturer_mean: float | None = None
    manufacturer_sd: float | None = None
    parallel_test_done: bool | None = None
    parallel_test_date: str | None = None
    new_standard_mean: float | None = None
    new_standard_sd: float | None = None
    in_use: bool | None = None
    active: bool | None = None
    remark: str | None = None


@router.patch("/reagent-qc/{reagent_qc_id}", summary="修改品管液")
def update_reagent_qc(reagent_qc_id: str, inp: ReagentQCUpdate):
    data = inp.model_dump(exclude_unset=True)
    code = data.pop("specimen_type_code", None)
    if code is not None:
        row = db.fetch_one(
            "SELECT specimen_type_id FROM specimen_type WHERE code = %s AND active = TRUE", (code,)
        )
        if not row:
            raise HTTPException(status_code=400, detail=f"檢體代碼不存在：{code}")
        data["specimen_type_id"] = row["specimen_type_id"]
    return _update_row("reagent_qc", reagent_qc_id, data)


@router.delete("/reagent-qc/{reagent_qc_id}", summary="刪除品管液")
def delete_reagent_qc(reagent_qc_id: str):
    return _delete_row("reagent_qc", reagent_qc_id, "此品管液已有品管紀錄")
