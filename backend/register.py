"""新增（register）相關 API — v3 分層式架構。

依 database_design/README.md 的建議寫入順序組織：
  1. 主檔：組別 / 儀器 / 檢體別 / 檢驗項目
  2. assay：儀器 × 項目 × 檢體（模型中心）
  3. 產品：試劑 / 品管液 / 校正液，以及三張 requirement mapping
  4. 批號：收貨時只新增 lot，不要為換批號另建 product
  5. 目標值：assay × QC 批號的 mean/SD（版本化）
  6. 品管執行：qc_runs + qc_results 同一交易
  7. 校正事件：calibration_events + assays + reagents 同一交易
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

import database as db
import westgard

router = APIRouter(prefix="/api", tags=["register"])


# ============================ 共用工具 ============================ #
def _integrity(e: Exception, what: str) -> HTTPException:
    msg = e.args[1] if len(e.args) > 1 else str(e)
    if "foreign key" in msg.lower():
        return HTTPException(status_code=400, detail=f"{what}失敗（關聯對象不存在）：{msg}")
    return HTTPException(status_code=409, detail=f"{what}失敗（重複或違反約束）：{msg}")


def _insert(table: str, data: dict[str, Any], pk_col: str, pk_val: str, what: str) -> dict:
    try:
        db.insert_one(table, data)
    except db.INTEGRITY_ERRORS as e:
        raise _integrity(e, what)
    row = db.get_by_pk(table, pk_col, pk_val)
    if not row:
        raise HTTPException(status_code=500, detail=f"{what}後查回失敗")
    return row


def _require(table: str, pk_col: str, pk_val: str, label: str) -> dict:
    row = db.get_by_pk(table, pk_col, pk_val)
    if not row:
        raise HTTPException(status_code=400, detail=f"{label}不存在：{pk_val}")
    return row


def _instrument_by_serial(serial: str) -> dict:
    row = db.fetch_one("SELECT * FROM instruments WHERE serial_number = %s", (serial,))
    if not row:
        raise HTTPException(status_code=400, detail=f"儀器不存在：{serial}")
    return row


def _lookup_id(table: str, pk_col: str, code_col: str, code: str, label: str) -> str:
    row = db.fetch_one(f"SELECT {pk_col} FROM {table} WHERE {code_col} = %s", (code,))
    if not row:
        raise HTTPException(status_code=400, detail=f"{label}不存在：{code}")
    return row[pk_col]


# ============================ 1. 主檔 ============================ #
class SectionIn(BaseModel):
    section_code: str
    section_name: str
    description: str | None = None


@router.post("/sections", summary="新增組別")
def create_section(inp: SectionIn):
    sid = db.new_id()
    return _insert("lab_sections", {"section_id": sid, **inp.model_dump()},
                   "section_id", sid, "新增組別")


class InstrumentIn(BaseModel):
    # model_name 與 pydantic 的保護前綴 model_ 同名，需解除限制
    model_config = ConfigDict(protected_namespaces=())

    serial_number: str
    instrument_name: str
    section_name: str | None = Field(None, description="與 section_id 二擇一")
    section_id: str | None = None
    manufacturer: str | None = None
    model_name: str | None = None
    instrument_role: str = Field("主機", description="主機 / 備機 / 其他")
    backup_of_serial_number: str | None = Field(None, description="若為備機，對應主機序號")
    installed_at: str | None = None


@router.post("/instruments", summary="新增儀器")
def create_instrument(inp: InstrumentIn):
    sid = inp.section_id or (
        _lookup_id("lab_sections", "section_id", "section_name", inp.section_name, "組別")
        if inp.section_name else None
    )
    if not sid:
        raise HTTPException(status_code=400, detail="必須提供 section_name 或 section_id")
    _require("lab_sections", "section_id", sid, "組別")

    backup_of = None
    if inp.backup_of_serial_number:
        backup_of = _instrument_by_serial(inp.backup_of_serial_number)["instrument_id"]

    iid = db.new_id()
    return _insert("instruments", {
        "instrument_id": iid, "section_id": sid,
        "serial_number": inp.serial_number, "instrument_name": inp.instrument_name,
        "manufacturer": inp.manufacturer, "model_name": inp.model_name,
        "instrument_role": inp.instrument_role, "backup_of_instrument_id": backup_of,
        "installed_at": inp.installed_at,
    }, "instrument_id", iid, "新增儀器")


class SpecimenTypeIn(BaseModel):
    specimen_code: str
    specimen_name: str
    description: str | None = None


@router.post("/specimen-types", summary="新增檢體別")
def create_specimen_type(inp: SpecimenTypeIn):
    sid = db.new_id()
    return _insert("specimen_types", {"specimen_type_id": sid, **inp.model_dump()},
                   "specimen_type_id", sid, "新增檢體別")


class TestItemIn(BaseModel):
    item_code: str
    item_name: str | None = None
    default_unit: str | None = None
    loinc_code: str | None = None
    description: str | None = None


@router.post("/test-items", summary="新增檢驗項目（全院字典）")
def create_test_item(inp: TestItemIn):
    tid = db.new_id()
    return _insert("test_items", {"test_item_id": tid, **inp.model_dump()},
                   "test_item_id", tid, "新增檢驗項目")


# ============================ 2. assay（模型中心）============================ #
class AssayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instrument_serial_number: str
    item_code: str = Field(..., description="檢驗項目代碼；不存在時可用 create_item_if_missing 自動建立")
    specimen_code: str = Field("B", description="檢體代碼，如 B / U / CSF")
    instrument_test_code: str | None = None
    method_name: str | None = None
    result_unit: str | None = None
    decimal_places: int = 2
    create_item_if_missing: bool = Field(False, description="項目字典沒有時自動建立")
    item_name: str | None = Field(None, description="自動建立項目時的全名")


def _resolve_assay_parts(inp: AssayIn) -> tuple[str, str, str]:
    inst = _instrument_by_serial(inp.instrument_serial_number)
    spec_id = _lookup_id("specimen_types", "specimen_type_id", "specimen_code",
                         inp.specimen_code, "檢體別")
    row = db.fetch_one("SELECT test_item_id FROM test_items WHERE item_code = %s", (inp.item_code,))
    if row:
        item_id = row["test_item_id"]
    elif inp.create_item_if_missing:
        item_id = db.new_id()
        db.insert_one("test_items", {
            "test_item_id": item_id, "item_code": inp.item_code,
            "item_name": inp.item_name, "default_unit": inp.result_unit,
        })
    else:
        raise HTTPException(
            status_code=400,
            detail=f"檢驗項目不存在：{inp.item_code}（如需自動建立請帶 create_item_if_missing=true）",
        )
    return inst["instrument_id"], item_id, spec_id


@router.post("/assays", summary="新增檢驗設定（儀器 × 項目 × 檢體）")
def create_assay(inp: AssayIn):
    instrument_id, item_id, spec_id = _resolve_assay_parts(inp)
    aid = db.new_id()
    try:
        db.insert_one("instrument_assays", {
            "assay_id": aid, "instrument_id": instrument_id,
            "test_item_id": item_id, "specimen_type_id": spec_id,
            "instrument_test_code": inp.instrument_test_code,
            "method_name": inp.method_name, "result_unit": inp.result_unit,
            "decimal_places": inp.decimal_places,
        })
    except db.INTEGRITY_ERRORS as e:
        msg = e.args[1] if len(e.args) > 1 else str(e)
        if "uq_assay_route" in msg:
            raise HTTPException(
                status_code=409,
                detail=f"此檢驗設定已存在：{inp.instrument_serial_number} × "
                       f"{inp.item_code} × {inp.specimen_code}",
            )
        raise _integrity(e, "新增檢驗設定")
    return db.fetch_one("SELECT * FROM v_assay_catalog WHERE assay_id = %s", (aid,))


class AssayBatchIn(BaseModel):
    instrument_serial_number: str
    specimen_code: str = "B"
    create_item_if_missing: bool = True
    items: list[str] = Field(..., description="項目代碼清單")


@router.post("/assays/batch", summary="批次新增檢驗設定（同一儀器 / 同一檢體）")
def create_assays_batch(inp: AssayBatchIn):
    created, skipped = [], []
    for code in inp.items:
        try:
            created.append(create_assay(AssayIn(
                instrument_serial_number=inp.instrument_serial_number,
                item_code=code, specimen_code=inp.specimen_code,
                create_item_if_missing=inp.create_item_if_missing,
            )))
        except HTTPException as e:
            if e.status_code == 409:
                skipped.append({"item_code": code, "reason": "已存在"})
            else:
                raise
    return {"created": len(created), "skipped": skipped, "assays": created}


# -------- 複製主機設定到備機 -------- #
class CopyToBackupIn(BaseModel):
    source_serial_number: str
    target_serial_number: str
    include_reagents: bool = True
    include_qc: bool = True
    include_calibrators: bool = True
    copy_qc_targets: bool = Field(
        False, description="是否一併複製品管目標值（備機通常需自行平測，預設不複製）"
    )


@router.post("/instruments/copy-to-backup", summary="複製主機設定到備機")
def copy_to_backup(inp: CopyToBackupIn):
    """把來源儀器的 assay 與產品關聯複製到目標儀器。

    已存在的 assay 與關聯會略過（不覆蓋）。品管目標值預設不複製，
    因為備機一般需自行平測建立自己的 mean/SD。
    """
    src = _instrument_by_serial(inp.source_serial_number)
    dst = _instrument_by_serial(inp.target_serial_number)
    if src["instrument_id"] == dst["instrument_id"]:
        raise HTTPException(status_code=400, detail="來源與目標不可為同一台儀器")

    stats = {"assays": 0, "reagents": 0, "qc": 0, "calibrators": 0, "qc_targets": 0}
    src_assays = db.fetch_all(
        "SELECT * FROM instrument_assays WHERE instrument_id = %s", (src["instrument_id"],)
    )

    with db.transaction() as cur:
        for a in src_assays:
            cur.execute(
                "SELECT assay_id FROM instrument_assays "
                "WHERE instrument_id=%s AND test_item_id=%s AND specimen_type_id=%s",
                (dst["instrument_id"], a["test_item_id"], a["specimen_type_id"]),
            )
            hit = cur.fetchone()
            if hit:
                new_aid = hit["assay_id"]
            else:
                new_aid = db.new_id()
                db.tx_insert(cur, "instrument_assays", {
                    "assay_id": new_aid, "instrument_id": dst["instrument_id"],
                    "test_item_id": a["test_item_id"], "specimen_type_id": a["specimen_type_id"],
                    "instrument_test_code": a["instrument_test_code"],
                    "method_name": a["method_name"], "result_unit": a["result_unit"],
                    "decimal_places": a["decimal_places"],
                })
                stats["assays"] += 1

            if inp.include_reagents:
                cur.execute("SELECT * FROM assay_reagent_requirements WHERE assay_id=%s",
                            (a["assay_id"],))
                for r in cur.fetchall():
                    stats["reagents"] += db.tx_insert_missing(cur, "assay_reagent_requirements", {
                        "assay_id": new_aid,
                        "reagent_product_id": r["reagent_product_id"],
                        "reagent_role": r["reagent_role"],
                        "required": r["required"],
                        "priority": r["priority"],
                        "note": r["note"],
                    })
            if inp.include_qc:
                cur.execute("SELECT * FROM assay_qc_requirements WHERE assay_id=%s",
                            (a["assay_id"],))
                for r in cur.fetchall():
                    stats["qc"] += db.tx_insert_missing(cur, "assay_qc_requirements", {
                        "assay_id": new_aid,
                        "qc_product_id": r["qc_product_id"],
                        "required": r["required"],
                        "priority": r["priority"],
                        "note": r["note"],
                    })
            if inp.include_calibrators:
                cur.execute("SELECT * FROM assay_calibrator_requirements WHERE assay_id=%s",
                            (a["assay_id"],))
                for r in cur.fetchall():
                    stats["calibrators"] += db.tx_insert_missing(cur, "assay_calibrator_requirements", {
                        "assay_id": new_aid,
                        "calibrator_product_id": r["calibrator_product_id"],
                        "required": r["required"],
                        "priority": r["priority"],
                        "note": r["note"],
                    })
            if inp.copy_qc_targets:
                cur.execute(
                    "SELECT * FROM qc_target_values WHERE assay_id=%s AND effective_to IS NULL",
                    (a["assay_id"],),
                )
                for t in cur.fetchall():
                    cur.execute(
                        "SELECT 1 FROM qc_target_values "
                        "WHERE assay_id=%s AND qc_lot_id=%s AND effective_to IS NULL",
                        (new_aid, t["qc_lot_id"]),
                    )
                    if cur.fetchone():
                        continue
                    db.tx_insert(cur, "qc_target_values", {
                        "qc_target_id": db.new_id(), "assay_id": new_aid,
                        "qc_lot_id": t["qc_lot_id"], "qc_product_id": t["qc_product_id"],
                        "target_source": t["target_source"], "target_mean": t["target_mean"],
                        "target_sd": t["target_sd"], "acceptable_low": t["acceptable_low"],
                        "acceptable_high": t["acceptable_high"],
                        "effective_from": datetime.now(),
                        "note": f"由 {src['serial_number']} 複製",
                    })
                    stats["qc_targets"] += 1

    return {
        "source": src["serial_number"], "target": dst["serial_number"],
        "created": stats,
        "message": "備機通常需自行平測；未複製目標值時請於「品管目標值」建立。"
                   if not inp.copy_qc_targets else None,
    }


# ============================ 3. 產品 ============================ #
class ProductIn(BaseModel):
    product_code: str
    product_name: str
    manufacturer: str | None = None
    catalog_number: str | None = None
    storage_condition: str | None = None


class MatrixProductIn(ProductIn):
    matrix_description: str | None = None


@router.post("/reagent-products", summary="新增試劑產品")
def create_reagent_product(inp: ProductIn):
    pid = db.new_id()
    return _insert("reagent_products", {"reagent_product_id": pid, **inp.model_dump()},
                   "reagent_product_id", pid, "新增試劑產品")


@router.post("/qc-products", summary="新增品管液產品")
def create_qc_product(inp: MatrixProductIn):
    pid = db.new_id()
    return _insert("qc_products", {"qc_product_id": pid, **inp.model_dump()},
                   "qc_product_id", pid, "新增品管液產品")


@router.post("/calibrator-products", summary="新增校正液產品")
def create_calibrator_product(inp: MatrixProductIn):
    pid = db.new_id()
    return _insert("calibrator_products", {"calibrator_product_id": pid, **inp.model_dump()},
                   "calibrator_product_id", pid, "新增校正液產品")


# -------- assay ↔ 產品關聯（整組覆寫）-------- #
class AssayReagentLink(BaseModel):
    reagent_product_id: str
    reagent_role: str = "PRIMARY"
    required: bool = True
    priority: int = 1


class AssayLinksIn(BaseModel):
    reagents: list[AssayReagentLink] | None = None
    qc_product_ids: list[str] | None = None
    calibrator_product_ids: list[str] | None = None


@router.put("/assays/{assay_id}/links", summary="設定 assay 的試劑 / 品管液 / 校正液關聯（整組覆寫）")
def set_assay_links(assay_id: str, inp: AssayLinksIn):
    _require("instrument_assays", "assay_id", assay_id, "檢驗設定")
    for lk in (inp.reagents or []):
        _require("reagent_products", "reagent_product_id", lk.reagent_product_id, "試劑產品")
    for pid in (inp.qc_product_ids or []):
        _require("qc_products", "qc_product_id", pid, "品管液產品")
    for pid in (inp.calibrator_product_ids or []):
        _require("calibrator_products", "calibrator_product_id", pid, "校正液產品")

    try:
        with db.transaction() as cur:
            if inp.reagents is not None:
                cur.execute("DELETE FROM assay_reagent_requirements WHERE assay_id=%s", (assay_id,))
                for lk in inp.reagents:
                    db.tx_insert(cur, "assay_reagent_requirements", {
                        "assay_id": assay_id, "reagent_product_id": lk.reagent_product_id,
                        "reagent_role": lk.reagent_role, "required": lk.required,
                        "priority": lk.priority,
                    })
            if inp.qc_product_ids is not None:
                cur.execute("DELETE FROM assay_qc_requirements WHERE assay_id=%s", (assay_id,))
                for pid in inp.qc_product_ids:
                    db.tx_insert(cur, "assay_qc_requirements",
                                 {"assay_id": assay_id, "qc_product_id": pid})
            if inp.calibrator_product_ids is not None:
                cur.execute("DELETE FROM assay_calibrator_requirements WHERE assay_id=%s",
                            (assay_id,))
                for pid in inp.calibrator_product_ids:
                    db.tx_insert(cur, "assay_calibrator_requirements",
                                 {"assay_id": assay_id, "calibrator_product_id": pid})
    except db.INTEGRITY_ERRORS as e:
        # 目標值/結果已引用該關聯時，RESTRICT 會擋下刪除
        raise HTTPException(
            status_code=409,
            detail=f"無法變更關聯：已有目標值或品管結果引用。{e.args[1] if len(e.args) > 1 else e}",
        )
    return {"assay_id": assay_id, "updated": True}


# ============================ 4. 批號 ============================ #
class ReagentLotIn(BaseModel):
    reagent_product_id: str
    lot_number: str
    received_at: str | None = None
    expiry_date: str | None = None
    quantity_received: float | None = None
    quantity_unit: str | None = None
    lot_status: str = "AVAILABLE"
    parallel_test_done: bool = False
    parallel_test_date: str | None = None
    same_lot_as_previous: bool = False
    previous_reagent_lot_id: str | None = None
    note: str | None = None


@router.post("/reagent-lots", summary="新增試劑批號（換批只需新增 lot，設定不受影響）")
def create_reagent_lot(inp: ReagentLotIn):
    _require("reagent_products", "reagent_product_id", inp.reagent_product_id, "試劑產品")
    lid = db.new_id()
    return _insert("reagent_lots", {"reagent_lot_id": lid, **inp.model_dump()},
                   "reagent_lot_id", lid, "新增試劑批號")


class QCLotIn(BaseModel):
    qc_product_id: str
    lot_number: str
    level_code: str
    received_at: str | None = None
    expiry_date: str | None = None
    lot_status: str = "AVAILABLE"
    parallel_test_done: bool = False
    parallel_test_date: str | None = None
    note: str | None = None


@router.post("/qc-lots", summary="新增品管液批號（同 kit 的每個濃度各一筆）")
def create_qc_lot(inp: QCLotIn):
    _require("qc_products", "qc_product_id", inp.qc_product_id, "品管液產品")
    lid = db.new_id()
    return _insert("qc_lots", {"qc_lot_id": lid, **inp.model_dump()},
                   "qc_lot_id", lid, "新增品管液批號")


class CalibratorLotIn(BaseModel):
    calibrator_product_id: str
    lot_number: str
    level_code: str = "DEFAULT"
    assigned_value_text: str | None = None
    received_at: str | None = None
    expiry_date: str | None = None
    lot_status: str = "AVAILABLE"
    note: str | None = None


@router.post("/calibrator-lots", summary="新增校正液批號")
def create_calibrator_lot(inp: CalibratorLotIn):
    _require("calibrator_products", "calibrator_product_id",
             inp.calibrator_product_id, "校正液產品")
    lid = db.new_id()
    return _insert("calibrator_lots", {"calibrator_lot_id": lid, **inp.model_dump()},
                   "calibrator_lot_id", lid, "新增校正液批號")


# ============================ 5. 品管目標值與平測 ============================ #
class QCTargetIn(BaseModel):
    assay_id: str
    qc_lot_id: str
    target_mean: float
    target_sd: float
    target_source: str = Field("MANUFACTURER", description="MANUFACTURER / LAB / PEER_GROUP")
    acceptable_low: float | None = None
    acceptable_high: float | None = None
    effective_from: str | None = None
    approved_by: str | None = None
    note: str | None = None


def _qc_product_of_lot(qc_lot_id: str) -> str:
    lot = _require("qc_lots", "qc_lot_id", qc_lot_id, "品管液批號")
    return lot["qc_product_id"]


@router.post("/qc-targets", summary="建立品管目標值")
def create_qc_target(inp: QCTargetIn):
    if inp.target_sd <= 0:
        raise HTTPException(status_code=400, detail="SD 必須大於 0")
    _require("instrument_assays", "assay_id", inp.assay_id, "檢驗設定")
    qc_product_id = _qc_product_of_lot(inp.qc_lot_id)

    if not db.fetch_one(
        "SELECT 1 AS x FROM assay_qc_requirements WHERE assay_id=%s AND qc_product_id=%s",
        (inp.assay_id, qc_product_id),
    ):
        raise HTTPException(
            status_code=400,
            detail="此檢驗設定尚未允許使用該品管液產品，請先於 assay 關聯中加入。",
        )
    if db.fetch_one(
        "SELECT 1 AS x FROM qc_target_values "
        "WHERE assay_id=%s AND qc_lot_id=%s AND effective_to IS NULL",
        (inp.assay_id, inp.qc_lot_id),
    ):
        raise HTTPException(
            status_code=409,
            detail="此 assay 與批號已有生效中的目標值；若要更新請使用平測 API（會自動收效舊版本）。",
        )

    tid = db.new_id()
    data = inp.model_dump(exclude={"effective_from"})
    data.update({
        "qc_target_id": tid, "qc_product_id": qc_product_id,
        "effective_from": inp.effective_from or datetime.now(),
    })
    return _insert("qc_target_values", data, "qc_target_id", tid, "建立品管目標值")


class ParallelTestIn(BaseModel):
    """平測：把舊版目標值收效，另建一筆實驗室值（LAB）。"""
    assay_id: str
    qc_lot_id: str
    new_mean: float
    new_sd: float
    acceptable_low: float | None = None
    acceptable_high: float | None = None
    effective_from: str | None = None
    approved_by: str | None = None
    note: str | None = None
    mark_lot_tested: bool = Field(True, description="一併把該批號標記為已完成平測")


@router.post("/qc-targets/parallel-test", summary="登錄平測結果（舊版收效 + 建立 LAB 版本）")
def parallel_test(inp: ParallelTestIn):
    """平測完成後呼叫。

    同一交易內：舊的生效中版本填入 effective_to → 新建 target_source='LAB' 版本
    → （可選）把 qc_lots 標記為已平測。歷史判讀因此仍可重現當時採用的值。
    """
    if inp.new_sd <= 0:
        raise HTTPException(status_code=400, detail="SD 必須大於 0")
    _require("instrument_assays", "assay_id", inp.assay_id, "檢驗設定")
    qc_product_id = _qc_product_of_lot(inp.qc_lot_id)
    if not db.fetch_one(
        "SELECT 1 AS x FROM assay_qc_requirements WHERE assay_id=%s AND qc_product_id=%s",
        (inp.assay_id, qc_product_id),
    ):
        raise HTTPException(status_code=400, detail="此檢驗設定尚未允許使用該品管液產品。")

    eff = inp.effective_from or datetime.now()
    prev = db.fetch_one(
        "SELECT * FROM qc_target_values "
        "WHERE assay_id=%s AND qc_lot_id=%s AND effective_to IS NULL",
        (inp.assay_id, inp.qc_lot_id),
    )
    new_id = db.new_id()
    try:
        with db.transaction() as cur:
            if prev:
                cur.execute(
                    "UPDATE qc_target_values SET effective_to=%s WHERE qc_target_id=%s",
                    (eff, prev["qc_target_id"]),
                )
            db.tx_insert(cur, "qc_target_values", {
                "qc_target_id": new_id, "assay_id": inp.assay_id, "qc_lot_id": inp.qc_lot_id,
                "qc_product_id": qc_product_id, "target_source": "LAB",
                "target_mean": inp.new_mean, "target_sd": inp.new_sd,
                "acceptable_low": inp.acceptable_low, "acceptable_high": inp.acceptable_high,
                "effective_from": eff, "approved_by": inp.approved_by,
                "note": inp.note or "平行測試建立",
            })
            if inp.mark_lot_tested:
                cur.execute(
                    "UPDATE qc_lots SET parallel_test_done=TRUE, parallel_test_date=%s "
                    "WHERE qc_lot_id=%s AND parallel_test_done=FALSE",
                    (date.today(), inp.qc_lot_id),
                )
    except db.INTEGRITY_ERRORS as e:
        raise _integrity(e, "登錄平測結果")

    return {
        "previous": {
            "qc_target_id": prev["qc_target_id"], "source": prev["target_source"],
            "mean": float(prev["target_mean"]), "sd": float(prev["target_sd"]),
        } if prev else None,
        "current": db.get_by_pk("qc_target_values", "qc_target_id", new_id),
    }


# ============================ 6. 品管執行 ============================ #
class QCResultIn(BaseModel):
    assay_id: str
    result_value: float
    reagent_lot_ids: list[str] = Field(default_factory=list)
    note: str | None = None


class QCRunIn(BaseModel):
    instrument_serial_number: str
    qc_lot_id: str
    run_at: str | None = None
    operator_id: str | None = None
    instrument_run_id: str | None = None
    results: list[QCResultIn]


@router.post("/qc-runs", summary="登錄一次品管執行（自動算 z-score 與 Westgard）")
def create_qc_run(inp: QCRunIn):
    """一瓶品管液跑一次可產生多個項目結果，整批寫在同一交易。

    每筆結果會：取當時生效的目標值 → 快照 mean/SD/unit → 由 DB 產生 z-score
    → 以同 assay + 同批號的歷史 z 序列做 Westgard 多規則判讀。
    """
    if not inp.results:
        raise HTTPException(status_code=400, detail="results 不可為空")
    inst = _instrument_by_serial(inp.instrument_serial_number)
    lot = _require("qc_lots", "qc_lot_id", inp.qc_lot_id, "品管液批號")
    run_at = inp.run_at or datetime.now()

    prepared = []
    for res in inp.results:
        assay = db.fetch_one("SELECT * FROM v_assay_catalog WHERE assay_id = %s", (res.assay_id,))
        if not assay:
            raise HTTPException(status_code=400, detail=f"檢驗設定不存在：{res.assay_id}")
        if assay["serial_number"] != inp.instrument_serial_number:
            raise HTTPException(
                status_code=400,
                detail=f"{assay['item_code']} 的檢驗設定不屬於儀器 {inp.instrument_serial_number}",
            )
        target = db.fetch_one(
            "SELECT * FROM qc_target_values "
            "WHERE assay_id=%s AND qc_lot_id=%s AND effective_to IS NULL",
            (res.assay_id, inp.qc_lot_id),
        )
        if not target:
            raise HTTPException(
                status_code=400,
                detail=f"{assay['item_code']}／{assay['specimen_code']} 尚未建立此品管批號的目標值，"
                       "請先於「品管目標值」設定。",
            )
        mean, sd = float(target["target_mean"]), float(target["target_sd"])
        z = round((res.result_value - mean) / sd, 4) if sd else None

        history = db.fetch_all(
            "SELECT r.z_score FROM qc_results r JOIN qc_runs run ON run.qc_run_id = r.qc_run_id "
            "WHERE r.assay_id=%s AND r.qc_lot_id=%s AND r.z_score IS NOT NULL "
            "ORDER BY run.run_at",
            (res.assay_id, inp.qc_lot_id),
        )
        z_series = [float(h["z_score"]) for h in history]
        if z is not None:
            z_series.append(z)
        rules = westgard.evaluate_series(z_series)
        status_map = {"Pass": "PASS", "Warning": "WARNING", "Fail": "FAIL"}
        status = status_map[westgard.status_from_rules(rules)]

        prepared.append({
            "res": res, "assay": assay, "target": target,
            "mean": mean, "sd": sd, "rules": rules, "status": status,
        })

    run_id = db.new_id()
    try:
        with db.transaction() as cur:
            db.tx_insert(cur, "qc_runs", {
                "qc_run_id": run_id, "instrument_id": inst["instrument_id"],
                "qc_lot_id": inp.qc_lot_id, "qc_product_id": lot["qc_product_id"],
                "run_at": run_at, "operator_id": inp.operator_id,
                "instrument_run_id": inp.instrument_run_id,
            })
            for p in prepared:
                rid = db.new_id()
                db.tx_insert(cur, "qc_results", {
                    "qc_result_id": rid, "qc_run_id": run_id,
                    "instrument_id": inst["instrument_id"], "assay_id": p["res"].assay_id,
                    "qc_lot_id": inp.qc_lot_id, "qc_product_id": lot["qc_product_id"],
                    "qc_target_id": p["target"]["qc_target_id"],
                    "result_value": p["res"].result_value,
                    "unit_snapshot": p["assay"]["result_unit"],
                    "target_mean_snapshot": p["mean"], "target_sd_snapshot": p["sd"],
                    "result_status": p["status"],
                    "westgard_flags": __import__("json").dumps(p["rules"]) if p["rules"] else None,
                    "note": p["res"].note,
                })
                for lot_id in p["res"].reagent_lot_ids:
                    rl = db.get_by_pk("reagent_lots", "reagent_lot_id", lot_id)
                    if not rl:
                        raise HTTPException(status_code=400, detail=f"試劑批號不存在：{lot_id}")
                    db.tx_insert(cur, "qc_result_reagents", {
                        "qc_result_id": rid, "assay_id": p["res"].assay_id,
                        "reagent_lot_id": lot_id,
                        "reagent_product_id": rl["reagent_product_id"],
                    })
    except db.INTEGRITY_ERRORS as e:
        raise _integrity(e, "登錄品管執行")

    return {
        "qc_run_id": run_id,
        "results": db.fetch_all(
            "SELECT * FROM v_qc_result_detail WHERE qc_run_id = %s ORDER BY item_code", (run_id,)
        ),
    }


# ============================ 7. 校正事件 ============================ #
class CalibrationAssayIn(BaseModel):
    assay_id: str
    assay_status: str = Field("PASS", description="PASS / FAIL / NOT_EVALUATED")
    pre_bias: float | None = None
    post_bias: float | None = None
    reagent_lot_ids: list[str] = Field(default_factory=list)
    note: str | None = None


class CalibrationEventIn(BaseModel):
    instrument_serial_number: str
    calibrator_lot_id: str
    performed_at: str | None = None
    operator_id: str | None = None
    calibration_reason: str = "SCHEDULED"
    event_status: str = "PASS"
    instrument_event_id: str | None = None
    note: str | None = None
    assays: list[CalibrationAssayIn] = Field(default_factory=list)


@router.post("/calibration-events", summary="登錄校正事件（含涵蓋項目與使用試劑）")
def create_calibration_event(inp: CalibrationEventIn):
    inst = _instrument_by_serial(inp.instrument_serial_number)
    lot = _require("calibrator_lots", "calibrator_lot_id", inp.calibrator_lot_id, "校正液批號")

    for a in inp.assays:
        assay = db.fetch_one("SELECT * FROM v_assay_catalog WHERE assay_id=%s", (a.assay_id,))
        if not assay:
            raise HTTPException(status_code=400, detail=f"檢驗設定不存在：{a.assay_id}")
        if assay["serial_number"] != inp.instrument_serial_number:
            raise HTTPException(
                status_code=400,
                detail=f"{assay['item_code']} 的檢驗設定不屬於儀器 {inp.instrument_serial_number}",
            )

    eid = db.new_id()
    try:
        with db.transaction() as cur:
            db.tx_insert(cur, "calibration_events", {
                "calibration_event_id": eid, "instrument_id": inst["instrument_id"],
                "calibrator_lot_id": inp.calibrator_lot_id,
                "calibrator_product_id": lot["calibrator_product_id"],
                "performed_at": inp.performed_at or datetime.now(),
                "operator_id": inp.operator_id,
                "calibration_reason": inp.calibration_reason,
                "event_status": inp.event_status,
                "instrument_event_id": inp.instrument_event_id, "note": inp.note,
            })
            for a in inp.assays:
                db.tx_insert(cur, "calibration_event_assays", {
                    "calibration_event_id": eid, "instrument_id": inst["instrument_id"],
                    "assay_id": a.assay_id,
                    "calibrator_product_id": lot["calibrator_product_id"],
                    "assay_status": a.assay_status, "pre_bias": a.pre_bias,
                    "post_bias": a.post_bias, "note": a.note,
                })
                for lot_id in a.reagent_lot_ids:
                    rl = db.get_by_pk("reagent_lots", "reagent_lot_id", lot_id)
                    if not rl:
                        raise HTTPException(status_code=400, detail=f"試劑批號不存在：{lot_id}")
                    db.tx_insert(cur, "calibration_event_reagents", {
                        "calibration_event_id": eid, "assay_id": a.assay_id,
                        "reagent_lot_id": lot_id,
                        "reagent_product_id": rl["reagent_product_id"],
                    })
    except db.INTEGRITY_ERRORS as e:
        raise _integrity(e, "登錄校正事件")

    return {
        "calibration_event_id": eid,
        "event": db.get_by_pk("calibration_events", "calibration_event_id", eid),
        "assays": db.fetch_all(
            "SELECT c.*, v.item_code, v.specimen_code FROM calibration_event_assays c "
            "JOIN v_assay_catalog v ON v.assay_id = c.assay_id "
            "WHERE c.calibration_event_id = %s", (eid,)
        ),
    }


@router.get("/calibration-events", summary="校正事件查詢")
def list_calibration_events(
    instrument_serial_number: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    limit: int = Query(200, le=2000),
):
    conds, params = [], []
    if instrument_serial_number:
        conds.append("i.serial_number = %s")
        params.append(instrument_serial_number)
    if date_from:
        conds.append("e.performed_at >= %s")
        params.append(f"{date_from} 00:00:00")
    if date_to:
        conds.append(f"e.performed_at < {db.NEXT_DAY}")
        params.append(date_to)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(limit)
    rows = db.fetch_all(
        "SELECT e.*, i.serial_number, i.instrument_name, "
        "       p.product_name AS calibrator_product_name, l.lot_number AS calibrator_lot_number "
        "FROM calibration_events e "
        "JOIN instruments i ON i.instrument_id = e.instrument_id "
        "JOIN calibrator_lots l ON l.calibrator_lot_id = e.calibrator_lot_id "
        "JOIN calibrator_products p ON p.calibrator_product_id = l.calibrator_product_id "
        f"{where} ORDER BY e.performed_at DESC LIMIT %s",
        tuple(params),
    )
    for r in rows:
        r["assays"] = db.fetch_all(
            "SELECT c.assay_status, c.pre_bias, c.post_bias, v.item_code, v.specimen_code "
            "FROM calibration_event_assays c "
            "JOIN v_assay_catalog v ON v.assay_id = c.assay_id "
            "WHERE c.calibration_event_id = %s ORDER BY v.item_code",
            (r["calibration_event_id"],),
        )
    return rows
