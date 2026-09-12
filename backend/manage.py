"""管理（manage）相關 API — v3：修改、停用與刪除。

刪除策略沿用 schema 的設計意圖：
  * 主檔停用用 `active = FALSE`，批號用 `lot_status`，不做硬刪除
  * DELETE 端點會先嘗試實際刪除；被外鍵 RESTRICT 擋下時回 409 並建議改用停用
  * 這是刻意的安全設計——品管結果與校正紀錄屬稽核軌跡，不應因主檔異動而消失
"""
from __future__ import annotations

from typing import Any

import pymysql
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

import database as db

router = APIRouter(prefix="/api", tags=["manage"])

# 資源名 → (資料表, 主鍵欄, 中文標籤, 是否有 active 欄位)
_RESOURCES: dict[str, tuple[str, str, str, bool]] = {
    "sections":            ("lab_sections",        "section_id",            "組別",       True),
    "instruments":         ("instruments",          "instrument_id",         "儀器",       True),
    "specimen-types":      ("specimen_types",       "specimen_type_id",      "檢體別",     True),
    "test-items":          ("test_items",           "test_item_id",          "檢驗項目",   True),
    "assays":              ("instrument_assays",    "assay_id",              "檢驗設定",   True),
    "reagent-products":    ("reagent_products",     "reagent_product_id",    "試劑產品",   True),
    "qc-products":         ("qc_products",          "qc_product_id",         "品管液產品", True),
    "calibrator-products": ("calibrator_products",  "calibrator_product_id", "校正液產品", True),
    "reagent-lots":        ("reagent_lots",         "reagent_lot_id",        "試劑批號",   False),
    "qc-lots":             ("qc_lots",              "qc_lot_id",             "品管液批號", False),
    "calibrator-lots":     ("calibrator_lots",      "calibrator_lot_id",     "校正液批號", False),
}


def _res(resource: str) -> tuple[str, str, str, bool]:
    if resource not in _RESOURCES:
        raise HTTPException(status_code=404, detail=f"不支援的資源：{resource}")
    return _RESOURCES[resource]


def _get_or_404(resource: str, pk: str) -> dict:
    table, pk_col, label, _ = _res(resource)
    row = db.get_by_pk(table, pk_col, pk)
    if not row:
        raise HTTPException(status_code=404, detail=f"查無{label}：{pk}")
    return row


def _update(resource: str, pk: str, data: dict[str, Any]) -> dict:
    table, pk_col, label, _ = _res(resource)
    _get_or_404(resource, pk)
    if data:
        try:
            db.update_by_pk(table, pk_col, pk, data)
        except pymysql.err.IntegrityError as e:
            msg = e.args[1] if len(e.args) > 1 else str(e)
            raise HTTPException(status_code=409, detail=f"更新{label}失敗：{msg}")
    return db.get_by_pk(table, pk_col, pk)


# ============================ 各資源的欄位更新 ============================ #
# 注意：本檔最後才註冊 /{resource}/{pk} 這類通用路由，
#       確保下方具名路由（如 /qc-targets/{pk}）先被比對到。
class SectionUpdate(BaseModel):
    section_code: str | None = None
    section_name: str | None = None
    description: str | None = None
    active: bool | None = None


@router.patch("/sections/{pk}", summary="修改組別")
def update_section(pk: str, inp: SectionUpdate):
    return _update("sections", pk, inp.model_dump(exclude_unset=True))


class InstrumentUpdate(BaseModel):
    # model_name 與 pydantic 的保護前綴 model_ 同名，需解除限制
    model_config = ConfigDict(protected_namespaces=())

    serial_number: str | None = None
    instrument_name: str | None = None
    section_id: str | None = None
    manufacturer: str | None = None
    model_name: str | None = None
    instrument_role: str | None = None
    backup_of_serial_number: str | None = Field(None, description="設為 '' 可解除主備機配對")
    installed_at: str | None = None
    retired_at: str | None = None
    active: bool | None = None


@router.patch("/instruments/{pk}", summary="修改儀器")
def update_instrument(pk: str, inp: InstrumentUpdate):
    data = inp.model_dump(exclude_unset=True)
    backup_serial = data.pop("backup_of_serial_number", None)
    if backup_serial is not None:
        if backup_serial == "":
            data["backup_of_instrument_id"] = None
        else:
            row = db.fetch_one("SELECT instrument_id FROM instruments WHERE serial_number = %s",
                               (backup_serial,))
            if not row:
                raise HTTPException(status_code=400, detail=f"主機序號不存在：{backup_serial}")
            if row["instrument_id"] == pk:
                raise HTTPException(status_code=400, detail="儀器不可指向自己為主機")
            data["backup_of_instrument_id"] = row["instrument_id"]
    if "section_id" in data:
        if not db.get_by_pk("lab_sections", "section_id", data["section_id"]):
            raise HTTPException(status_code=400, detail="組別不存在")
    return _update("instruments", pk, data)


class TestItemUpdate(BaseModel):
    item_code: str | None = None
    item_name: str | None = None
    default_unit: str | None = None
    loinc_code: str | None = None
    description: str | None = None
    active: bool | None = None


@router.patch("/test-items/{pk}", summary="修改檢驗項目字典")
def update_test_item(pk: str, inp: TestItemUpdate):
    return _update("test-items", pk, inp.model_dump(exclude_unset=True))


class SpecimenTypeUpdate(BaseModel):
    specimen_code: str | None = None
    specimen_name: str | None = None
    description: str | None = None
    active: bool | None = None


@router.patch("/specimen-types/{pk}", summary="修改檢體別")
def update_specimen_type(pk: str, inp: SpecimenTypeUpdate):
    return _update("specimen-types", pk, inp.model_dump(exclude_unset=True))


class AssayUpdate(BaseModel):
    instrument_test_code: str | None = None
    method_name: str | None = None
    result_unit: str | None = None
    decimal_places: int | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    active: bool | None = None


@router.patch("/assays/{pk}", summary="修改檢驗設定")
def update_assay(pk: str, inp: AssayUpdate):
    """只允許改設定屬性。儀器／項目／檢體屬於 assay 身分，
    要變更請停用此筆、另建新的，以免歷史結果失去意義。"""
    row = _update("assays", pk, inp.model_dump(exclude_unset=True))
    return db.fetch_one("SELECT * FROM v_assay_catalog WHERE assay_id = %s",
                        (row["assay_id"],)) or row


class ProductUpdate(BaseModel):
    product_code: str | None = None
    product_name: str | None = None
    manufacturer: str | None = None
    catalog_number: str | None = None
    storage_condition: str | None = None
    matrix_description: str | None = None
    active: bool | None = None


@router.patch("/reagent-products/{pk}", summary="修改試劑產品")
def update_reagent_product(pk: str, inp: ProductUpdate):
    data = inp.model_dump(exclude_unset=True)
    data.pop("matrix_description", None)  # 試劑產品無此欄位
    return _update("reagent-products", pk, data)


@router.patch("/qc-products/{pk}", summary="修改品管液產品")
def update_qc_product(pk: str, inp: ProductUpdate):
    return _update("qc-products", pk, inp.model_dump(exclude_unset=True))


@router.patch("/calibrator-products/{pk}", summary="修改校正液產品")
def update_calibrator_product(pk: str, inp: ProductUpdate):
    return _update("calibrator-products", pk, inp.model_dump(exclude_unset=True))


class ReagentLotUpdate(BaseModel):
    lot_number: str | None = None
    received_at: str | None = None
    opened_at: str | None = None
    expiry_date: str | None = None
    quantity_received: float | None = None
    quantity_unit: str | None = None
    lot_status: str | None = None
    parallel_test_done: bool | None = None
    parallel_test_date: str | None = None
    same_lot_as_previous: bool | None = None
    previous_reagent_lot_id: str | None = None
    note: str | None = None


@router.patch("/reagent-lots/{pk}", summary="修改試劑批號")
def update_reagent_lot(pk: str, inp: ReagentLotUpdate):
    return _update("reagent-lots", pk, inp.model_dump(exclude_unset=True))


class QCLotUpdate(BaseModel):
    lot_number: str | None = None
    level_code: str | None = None
    received_at: str | None = None
    opened_at: str | None = None
    expiry_date: str | None = None
    lot_status: str | None = None
    parallel_test_done: bool | None = None
    parallel_test_date: str | None = None
    note: str | None = None


@router.patch("/qc-lots/{pk}", summary="修改品管液批號")
def update_qc_lot(pk: str, inp: QCLotUpdate):
    return _update("qc-lots", pk, inp.model_dump(exclude_unset=True))


class CalibratorLotUpdate(BaseModel):
    lot_number: str | None = None
    level_code: str | None = None
    assigned_value_text: str | None = None
    received_at: str | None = None
    opened_at: str | None = None
    expiry_date: str | None = None
    lot_status: str | None = None
    note: str | None = None


@router.patch("/calibrator-lots/{pk}", summary="修改校正液批號")
def update_calibrator_lot(pk: str, inp: CalibratorLotUpdate):
    return _update("calibrator-lots", pk, inp.model_dump(exclude_unset=True))


# ============================ 品管目標值 ============================ #
class QCTargetUpdate(BaseModel):
    """僅允許修正非數值的附註類欄位。

    mean/SD 屬於已被品管結果快照引用的判讀依據，要調整請走平測 API
    （建立新版本並收效舊版），以保留稽核軌跡。
    """
    acceptable_low: float | None = None
    acceptable_high: float | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    note: str | None = None


@router.patch("/qc-targets/{pk}", summary="修改品管目標值的附註欄位")
def update_qc_target(pk: str, inp: QCTargetUpdate):
    row = db.get_by_pk("qc_target_values", "qc_target_id", pk)
    if not row:
        raise HTTPException(status_code=404, detail=f"查無品管目標值：{pk}")
    data = inp.model_dump(exclude_unset=True)
    if data:
        try:
            db.update_by_pk("qc_target_values", "qc_target_id", pk, data)
        except pymysql.err.IntegrityError as e:
            raise HTTPException(status_code=409,
                                detail=f"更新失敗：{e.args[1] if len(e.args) > 1 else e}")
    return db.get_by_pk("qc_target_values", "qc_target_id", pk)


@router.delete("/qc-targets/{pk}", summary="刪除品管目標值（已被結果引用時會被擋下）")
def delete_qc_target(pk: str):
    if not db.get_by_pk("qc_target_values", "qc_target_id", pk):
        raise HTTPException(status_code=404, detail=f"查無品管目標值：{pk}")
    try:
        db.execute("DELETE FROM qc_target_values WHERE qc_target_id = %s", (pk,))
    except pymysql.err.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="此目標值已被品管結果引用，無法刪除。若要停用請建立新版本（平測 API）。",
        )
    return {"deleted": True, "qc_target_id": pk}


# ============================ 試劑上機 ============================ #
class ReagentLoadIn(BaseModel):
    instrument_serial_number: str
    reagent_lot_id: str
    position_code: str
    loaded_at: str | None = None
    loaded_by: str | None = None
    note: str | None = None


@router.post("/reagent-loads", summary="試劑上機")
def load_reagent(inp: ReagentLoadIn):
    from datetime import datetime

    inst = db.fetch_one("SELECT instrument_id FROM instruments WHERE serial_number = %s",
                        (inp.instrument_serial_number,))
    if not inst:
        raise HTTPException(status_code=400, detail=f"儀器不存在：{inp.instrument_serial_number}")
    if not db.get_by_pk("reagent_lots", "reagent_lot_id", inp.reagent_lot_id):
        raise HTTPException(status_code=400, detail=f"試劑批號不存在：{inp.reagent_lot_id}")

    lid = db.new_id()
    try:
        db.insert_one("instrument_reagent_loads", {
            "reagent_load_id": lid, "instrument_id": inst["instrument_id"],
            "reagent_lot_id": inp.reagent_lot_id, "position_code": inp.position_code,
            "loaded_at": inp.loaded_at or datetime.now(),
            "loaded_by": inp.loaded_by, "note": inp.note,
        })
    except pymysql.err.IntegrityError as e:
        msg = e.args[1] if len(e.args) > 1 else str(e)
        if "uq_current_instrument_position" in msg:
            raise HTTPException(
                status_code=409,
                detail=f"位置 {inp.position_code} 已有試劑在線上，請先下機再裝載。",
            )
        raise HTTPException(status_code=400, detail=f"上機失敗：{msg}")
    return db.get_by_pk("instrument_reagent_loads", "reagent_load_id", lid)


class ReagentUnloadIn(BaseModel):
    unloaded_at: str | None = None
    unloaded_by: str | None = None


@router.patch("/reagent-loads/{pk}/unload", summary="試劑下機")
def unload_reagent(pk: str, inp: ReagentUnloadIn):
    from datetime import datetime

    row = db.get_by_pk("instrument_reagent_loads", "reagent_load_id", pk)
    if not row:
        raise HTTPException(status_code=404, detail=f"查無上機紀錄：{pk}")
    if row["unloaded_at"]:
        raise HTTPException(status_code=409, detail="此批試劑已下機")
    db.update_by_pk("instrument_reagent_loads", "reagent_load_id", pk, {
        "unloaded_at": inp.unloaded_at or datetime.now(),
        "unloaded_by": inp.unloaded_by,
    })
    return db.get_by_pk("instrument_reagent_loads", "reagent_load_id", pk)


@router.get("/reagent-loads", summary="試劑上機紀錄")
def list_reagent_loads(
    instrument_serial_number: str | None = Query(None),
    current_only: bool = Query(True, description="只列出目前在線上的"),
):
    conds, params = [], []
    if instrument_serial_number:
        conds.append("i.serial_number = %s")
        params.append(instrument_serial_number)
    if current_only:
        conds.append("l.unloaded_at IS NULL")
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    return db.fetch_all(
        "SELECT l.*, i.serial_number, i.instrument_name, "
        "       rl.lot_number, rl.expiry_date, rl.lot_status, p.product_name "
        "FROM instrument_reagent_loads l "
        "JOIN instruments i ON i.instrument_id = l.instrument_id "
        "JOIN reagent_lots rl ON rl.reagent_lot_id = l.reagent_lot_id "
        "JOIN reagent_products p ON p.reagent_product_id = rl.reagent_product_id "
        f"{where} ORDER BY l.loaded_at DESC",
        tuple(params),
    )


# ==========================================================================
# 通用路由 — 必須最後註冊，否則 /{resource}/{pk} 會蓋掉上方的具名路由
# （例如 DELETE /api/qc-targets/{id}）
# ==========================================================================
class ActiveIn(BaseModel):
    active: bool


@router.patch("/{resource}/{pk}/active", summary="停用／啟用主檔（保留歷史關聯）")
def set_active(resource: str, pk: str, inp: ActiveIn):
    _, _, label, has_active = _res(resource)
    if not has_active:
        raise HTTPException(
            status_code=400,
            detail=f"{label}沒有 active 欄位；批號請改用 /{resource}/{{id}}/status 變更 lot_status。",
        )
    return _update(resource, pk, {"active": inp.active})


_LOT_STATUSES = {"QUARANTINE", "AVAILABLE", "IN_USE", "EXHAUSTED", "EXPIRED", "RECALLED"}


class LotStatusIn(BaseModel):
    lot_status: str = Field(
        ..., description="QUARANTINE / AVAILABLE / IN_USE / EXHAUSTED / EXPIRED / RECALLED"
    )


@router.patch("/{resource}/{pk}/status", summary="變更批號狀態")
def set_lot_status(resource: str, pk: str, inp: LotStatusIn):
    _, _, label, has_active = _res(resource)
    if has_active:
        raise HTTPException(status_code=400, detail=f"{label}請改用 /active 端點停用。")
    if inp.lot_status not in _LOT_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"不合法的狀態：{inp.lot_status}（可用：{sorted(_LOT_STATUSES)}）")
    return _update(resource, pk, {"lot_status": inp.lot_status})


@router.delete("/{resource}/{pk}", summary="刪除（被引用時回 409，建議改用停用）")
def delete_resource(resource: str, pk: str):
    table, pk_col, label, has_active = _res(resource)
    _get_or_404(resource, pk)
    try:
        db.execute(f"DELETE FROM {table} WHERE {pk_col} = %s", (pk,))
    except pymysql.err.IntegrityError:
        hint = "停用（active=false）" if has_active else "改變批號狀態（如 EXHAUSTED）"
        raise HTTPException(
            status_code=409,
            detail=f"無法刪除此{label}：已被其他資料引用（品管結果、目標值或關聯設定）。"
                   f"建議改用{hint}以保留稽核軌跡。",
        )
    return {"deleted": True, "resource": resource, "id": pk}
