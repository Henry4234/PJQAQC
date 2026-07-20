"""新增（register）相關 API。

集中管理所有「新增主檔 / 建立關聯」的端點，供前端管理畫面使用：
  - 組別   lab_group
  - 儀器   instruments
  - 項目   items（單筆 / 批次）
  - 檢體類別 specimen_type
  - 試劑   reagent（可同時指定可操作的檢體類別，多對多）
  - 品管液 reagent_qc（各針對一種檢體類別）
  - 品管↔試劑 關聯 qc_reagent_map
  - 試劑↔項目 關聯 reagent_item_map
  - 試劑↔檢體 關聯 reagent_specimen_map

以 APIRouter 實作，於 main.py 用 `app.include_router(register.router)` 掛載。
另附少量 GET 清單端點，供前端下拉選單帶資料。
"""
from __future__ import annotations

import uuid
from typing import Any

import pymysql
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import database as db

router = APIRouter(prefix="/api", tags=["register"])


# ============================ 共用工具 ============================ #
def _do_insert(table: str, data: dict[str, Any]) -> int:
    """執行 INSERT，回傳 lastrowid；IntegrityError 轉為 409。

    table 名稱與欄位皆為程式碼內的字面值（非使用者輸入），故字串組裝安全；
    所有「值」一律以參數化方式帶入。
    """
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["%s"] * len(data))
    sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
    try:
        return db.execute(sql, tuple(data.values()))
    except pymysql.err.IntegrityError as e:
        msg = e.args[1] if len(e.args) > 1 else str(e)
        raise HTTPException(status_code=409, detail=f"新增 {table} 失敗（重複鍵或關聯不存在）：{msg}")


def _insert_and_get(table: str, data: dict[str, Any], pk_col: str, pk_val: Any = None) -> dict:
    """INSERT 後以主鍵查回完整資料列。

    pk_val=None 時使用 AUTO_INCREMENT 的 lastrowid（適用中介表）；
    否則以指定主鍵查回（適用 UUID / serial_number 主鍵）。
    """
    last = _do_insert(table, data)
    key = last if pk_val is None else pk_val
    row = db.fetch_one(f"SELECT * FROM {table} WHERE {pk_col} = %s", (key,))
    if not row:
        raise HTTPException(status_code=500, detail=f"{table} 新增後查回失敗")
    return row


def _resolve_group_id(group_id: str | None, group_name: str | None) -> str | None:
    """由 group_id 或 group_name 取得有效的 group_id；皆為空回傳 None。"""
    if group_id:
        if not db.fetch_one("SELECT group_id FROM lab_group WHERE group_id = %s", (group_id,)):
            raise HTTPException(status_code=400, detail=f"group_id 不存在：{group_id}")
        return group_id
    if group_name:
        row = db.fetch_one("SELECT group_id FROM lab_group WHERE group_name = %s", (group_name,))
        if not row:
            raise HTTPException(status_code=400, detail=f"組別不存在：{group_name}")
        return row["group_id"]
    return None


def _group_of_instrument(serial_number: str | None) -> str | None:
    if not serial_number:
        return None
    row = db.fetch_one("SELECT group_id FROM instruments WHERE serial_number = %s", (serial_number,))
    return row["group_id"] if row else None


def _resolve_specimen_id(code: str) -> str:
    """由檢體代碼 (B / U / CSF ...) 取得 specimen_type_id，找不到回 400。"""
    row = db.fetch_one(
        "SELECT specimen_type_id FROM specimen_type WHERE code = %s AND active = TRUE", (code,)
    )
    if not row:
        raise HTTPException(status_code=400, detail=f"檢體代碼不存在：{code}")
    return row["specimen_type_id"]


# ============================ 1. 組別 lab_group ============================ #
class LabGroupIn(BaseModel):
    group_name: str
    group_code: str | None = None
    description: str | None = None
    active: bool = True


@router.post("/lab-groups", summary="新增組別")
def create_lab_group(inp: LabGroupIn):
    new_id = str(uuid.uuid4())
    data = {
        "group_id": new_id,
        "group_name": inp.group_name,
        "group_code": inp.group_code,
        "description": inp.description,
        "active": inp.active,
    }
    return _insert_and_get("lab_group", data, "group_id", new_id)


@router.get("/lab-groups", summary="組別清單")
def list_lab_groups():
    return db.fetch_all("SELECT * FROM lab_group WHERE active = TRUE ORDER BY group_name")


# ============================ 2. 儀器 instruments ============================ #
class InstrumentIn(BaseModel):
    serial_number: str
    instrument_name: str
    group_id: str | None = None
    group_name: str | None = Field(None, description="與 group_id 二擇一")
    machine_role: str = "主機"
    active: bool = True


@router.post("/instruments", summary="新增儀器")
def create_instrument(inp: InstrumentIn):
    gid = _resolve_group_id(inp.group_id, inp.group_name)
    if not gid:
        raise HTTPException(status_code=400, detail="必須提供 group_id 或 group_name")
    data = {
        "serial_number": inp.serial_number,
        "instrument_name": inp.instrument_name,
        "group_id": gid,
        "machine_role": inp.machine_role,
        "active": inp.active,
    }
    return _insert_and_get("instruments", data, "serial_number", inp.serial_number)


# ============================ 3. 項目 items ============================ #
class ItemIn(BaseModel):
    instrument_serial_number: str
    item_code: str
    item_name: str | None = None
    unit: str | None = None
    sort_order: int = 0
    group_id: str | None = Field(None, description="留空則由儀器帶出所屬組別")
    active: bool = True


def _build_item_row(instrument_sn: str, code: str, name: str | None, unit: str | None,
                    sort_order: int, group_id: str | None, active: bool) -> dict:
    gid = group_id or _group_of_instrument(instrument_sn)
    new_id = str(uuid.uuid4())
    return {
        "item_id": new_id,
        "instrument_serial_number": instrument_sn,
        "group_id": gid,
        "item_code": code,
        "item_name": name,
        "unit": unit,
        "sort_order": sort_order,
        "active": active,
    }


@router.post("/items", summary="新增單一檢驗項目")
def create_item(inp: ItemIn):
    data = _build_item_row(inp.instrument_serial_number, inp.item_code, inp.item_name,
                           inp.unit, inp.sort_order, inp.group_id, inp.active)
    return _insert_and_get("items", data, "item_id", data["item_id"])


class ItemEntry(BaseModel):
    item_code: str
    item_name: str | None = None
    unit: str | None = None
    sort_order: int = 0


class ItemBatchIn(BaseModel):
    instrument_serial_number: str
    group_id: str | None = None
    items: list[ItemEntry]


@router.post("/items/batch", summary="批次新增檢驗項目（同一台儀器）")
def create_items_batch(inp: ItemBatchIn):
    if not inp.items:
        raise HTTPException(status_code=400, detail="items 不可為空")
    created = []
    for it in inp.items:
        data = _build_item_row(inp.instrument_serial_number, it.item_code, it.item_name,
                               it.unit, it.sort_order, inp.group_id, True)
        created.append(_insert_and_get("items", data, "item_id", data["item_id"]))
    return {"created": len(created), "items": created}


@router.get("/items", summary="項目清單（可依儀器過濾）")
def list_items(instrument_serial_number: str | None = Query(None)):
    if instrument_serial_number:
        return db.fetch_all(
            "SELECT * FROM items WHERE instrument_serial_number = %s AND active = TRUE "
            "ORDER BY sort_order, item_code",
            (instrument_serial_number,),
        )
    return db.fetch_all("SELECT * FROM items WHERE active = TRUE ORDER BY instrument_serial_number, sort_order")


# ============================ 4. 檢體類別 specimen_type ============================ #
class SpecimenTypeIn(BaseModel):
    code: str = Field(..., description="檢體代碼，如 B / U / CSF")
    name: str = Field(..., description="檢體名稱，如 BLOOD / URINE / CSF")
    description: str | None = None
    active: bool = True


@router.post("/specimen-types", summary="新增檢體類別")
def create_specimen_type(inp: SpecimenTypeIn):
    new_id = str(uuid.uuid4())
    data = {"specimen_type_id": new_id, **inp.model_dump()}
    return _insert_and_get("specimen_type", data, "specimen_type_id", new_id)


@router.get("/specimen-types", summary="檢體類別清單")
def list_specimen_types():
    return db.fetch_all("SELECT * FROM specimen_type WHERE active = TRUE ORDER BY code")


# ============================ 5. 試劑 reagent ============================ #
class ReagentIn(BaseModel):
    instrument_serial_number: str | None = None
    group_id: str | None = None
    test_item: str
    reagent_name: str
    lot_number: str
    manufacturer: str | None = None
    in_stock: bool = False
    in_stock_date: str | None = None
    parallel_test_done: bool = False
    parallel_test_date: str | None = None
    same_lot_as_previous: bool = False
    previous_lot_number: str | None = None
    expiry_date: str | None = None
    active: bool = True
    remark: str | None = None
    specimen_type_codes: list[str] = Field(
        default_factory=list,
        description="此試劑可操作的檢體代碼清單（多對多），如 ['U', 'CSF']",
    )


@router.post("/reagents", summary="新增試劑（可同時指定可操作的檢體類別）")
def create_reagent(inp: ReagentIn):
    # 先解析全部檢體代碼，全數有效才寫入，避免試劑建立後關聯建到一半失敗
    specimen_ids = [_resolve_specimen_id(c) for c in inp.specimen_type_codes]

    gid = _resolve_group_id(inp.group_id, None) or _group_of_instrument(inp.instrument_serial_number)
    new_id = str(uuid.uuid4())
    data = {
        "reagent_id": new_id,
        "group_id": gid,
        **inp.model_dump(exclude={"group_id", "specimen_type_codes"}),
    }
    row = _insert_and_get("reagent", data, "reagent_id", new_id)

    for sid in specimen_ids:
        _do_insert("reagent_specimen_map", {"reagent_id": new_id, "specimen_type_id": sid})
    row["specimen_type_codes"] = inp.specimen_type_codes
    return row


@router.get("/reagents", summary="試劑清單（可依儀器過濾，含可操作檢體代碼）")
def list_reagents(instrument_serial_number: str | None = Query(None)):
    sql = (
        "SELECT r.*, GROUP_CONCAT(s.code ORDER BY s.code) AS specimen_type_codes "
        "FROM reagent r "
        "LEFT JOIN reagent_specimen_map m ON m.reagent_id = r.reagent_id "
        "LEFT JOIN specimen_type s ON s.specimen_type_id = m.specimen_type_id "
        "WHERE r.active = TRUE "
    )
    params: tuple = ()
    if instrument_serial_number:
        sql += "AND r.instrument_serial_number = %s "
        params = (instrument_serial_number,)
    sql += "GROUP BY r.reagent_id ORDER BY r.reagent_name"
    rows = db.fetch_all(sql, params)
    for r in rows:
        r["specimen_type_codes"] = r["specimen_type_codes"].split(",") if r["specimen_type_codes"] else []
    return rows


# ============================ 6. 品管液 reagent_qc ============================ #
class ReagentQCIn(BaseModel):
    instrument_serial_number: str | None = None
    group_id: str | None = None
    specimen_type_code: str | None = Field(
        None,
        description="此品管液針對的檢體代碼，如 B / U / CSF（同一項目不同檢體用不同品管液）",
    )
    test_item: str
    test_item_full_name: str | None = None
    qc_level: str
    qc_lot_number: str
    unit: str | None = None
    manufacturer_mean: float | None = None
    manufacturer_sd: float | None = None
    parallel_test_done: bool = False
    parallel_test_date: str | None = None
    new_standard_mean: float | None = None
    new_standard_sd: float | None = None
    in_use: bool = True
    active: bool = True
    remark: str | None = None


@router.post("/reagent-qc", summary="新增品管液（可指定針對的檢體類別）")
def create_reagent_qc(inp: ReagentQCIn):
    specimen_id = _resolve_specimen_id(inp.specimen_type_code) if inp.specimen_type_code else None
    gid = _resolve_group_id(inp.group_id, None) or _group_of_instrument(inp.instrument_serial_number)
    new_id = str(uuid.uuid4())
    data = {
        "reagent_qc_id": new_id,
        "group_id": gid,
        "specimen_type_id": specimen_id,
        **inp.model_dump(exclude={"group_id", "specimen_type_code"}),
    }
    return _insert_and_get("reagent_qc", data, "reagent_qc_id", new_id)


@router.get("/reagent-qc", summary="品管液清單（可依儀器 / 檢體過濾）")
def list_reagent_qc(
    instrument_serial_number: str | None = Query(None),
    specimen_type_code: str | None = Query(None, description="檢體代碼，如 B / U / CSF"),
):
    sql = (
        "SELECT q.*, s.code AS specimen_type_code, s.name AS specimen_type_name "
        "FROM reagent_qc q "
        "LEFT JOIN specimen_type s ON s.specimen_type_id = q.specimen_type_id "
        "WHERE q.active = TRUE "
    )
    params: list = []
    if instrument_serial_number:
        sql += "AND q.instrument_serial_number = %s "
        params.append(instrument_serial_number)
    if specimen_type_code:
        sql += "AND s.code = %s "
        params.append(specimen_type_code)
    sql += "ORDER BY q.test_item, q.qc_level"
    return db.fetch_all(sql, tuple(params))


# ============================ 7. 品管 ↔ 試劑 關聯 ============================ #
class QCReagentMapIn(BaseModel):
    reagent_qc_id: str
    reagent_id: str


@router.post("/qc-reagent-map", summary="建立品管↔試劑關聯")
def create_qc_reagent_map(inp: QCReagentMapIn):
    data = {"reagent_qc_id": inp.reagent_qc_id, "reagent_id": inp.reagent_id}
    return _insert_and_get("qc_reagent_map", data, "id")


# ============================ 8. 試劑 ↔ 項目 關聯 ============================ #
class ReagentItemMapIn(BaseModel):
    reagent_id: str
    item_id: str


@router.post("/reagent-item-map", summary="建立試劑↔項目關聯")
def create_reagent_item_map(inp: ReagentItemMapIn):
    data = {"reagent_id": inp.reagent_id, "item_id": inp.item_id}
    return _insert_and_get("reagent_item_map", data, "id")


# ============================ 9. 試劑 ↔ 檢體 關聯 ============================ #
class ReagentSpecimenMapIn(BaseModel):
    reagent_id: str
    specimen_type_code: str = Field(..., description="檢體代碼，如 B / U / CSF")


@router.post("/reagent-specimen-map", summary="建立試劑↔檢體關聯（試劑新增後補加檢體）")
def create_reagent_specimen_map(inp: ReagentSpecimenMapIn):
    sid = _resolve_specimen_id(inp.specimen_type_code)
    data = {"reagent_id": inp.reagent_id, "specimen_type_id": sid}
    return _insert_and_get("reagent_specimen_map", data, "id")
