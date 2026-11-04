"""將 MariaDB v3 一致性快照匯入空的 PostgreSQL qaqc schema。"""
from __future__ import annotations

import argparse
import os
from contextlib import closing
from pathlib import Path

import psycopg
import pymysql
from dotenv import dotenv_values
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

TABLES = (
    "lab_sections", "instruments", "specimen_types", "test_items", "instrument_assays",
    "reagent_products", "qc_products", "calibrator_products",
    "assay_reagent_requirements", "assay_qc_requirements", "assay_calibrator_requirements",
    "reagent_lots", "qc_lots", "calibrator_lots", "qc_target_values", "instrument_reagent_loads",
    "qc_runs", "qc_results", "qc_result_reagents",
    "calibration_events", "calibration_event_assays", "calibration_event_reagents",
)


def copy_snapshot(source, target, commit: bool) -> None:
    with source.cursor() as mysql, target.cursor() as pg:
        mysql.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        mysql.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        mysql.execute(
            "SELECT table_name, engine FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
        )
        engines = dict(mysql.fetchall())
        for table in TABLES:
            if engines.get(table) != "InnoDB":
                raise ValueError(f"來源表 {table} 必須是 v3 InnoDB 表")

        pg.execute("SET LOCAL lock_timeout = '10s'")
        pg.execute("SELECT pg_advisory_xact_lock(1816728423)")
        pg.execute("SET LOCAL search_path TO qaqc, pg_catalog")
        pg.execute("SET CONSTRAINTS ALL DEFERRED")
        for table in TABLES:
            relation = sql.Identifier("qaqc", table)
            pg.execute(sql.SQL("SELECT EXISTS (SELECT 1 FROM {})").format(relation))
            if pg.fetchone()[0]:
                raise ValueError(f"目的表 {table} 已有資料。匯入僅適用於空的 v3 schema")

        for table in TABLES:
            pg.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = 'qaqc' AND table_name = %s AND is_generated = 'NEVER' "
                "ORDER BY ordinal_position",
                (table,),
            )
            columns = pg.fetchall()
            if not columns:
                raise ValueError(f"目的表 {table} 缺少可寫欄位")
            names = [name for name, _ in columns]
            bool_indexes = [index for index, (_, kind) in enumerate(columns) if kind == "boolean"]
            column_list = sql.SQL(", ").join(map(sql.Identifier, names))
            query = sql.SQL("COPY {} ({}) FROM STDIN").format(sql.Identifier("qaqc", table), column_list)

            mysql.execute(f"SELECT COUNT(*) FROM `{table}`")
            expected = mysql.fetchone()[0]
            mysql_columns = ", ".join(f"`{name}`" for name in names)
            with source.cursor(pymysql.cursors.SSCursor) as rows, pg.copy(query) as batch:
                rows.execute(f"SELECT {mysql_columns} FROM `{table}`")
                for values in rows:
                    row = list(values)
                    for index in bool_indexes:
                        if row[index] not in (None, 0, 1):
                            raise ValueError(f"{table}.{names[index]} 不是有效的布林值")
                        if row[index] is not None:
                            row[index] = bool(row[index])
                    batch.write_row(row)

            pg.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier("qaqc", table)))
            if pg.fetchone()[0] != expected:
                raise ValueError(f"{table} 匯入筆數不符")
            print(f"{table}: {expected}")

        pg.execute("SET CONSTRAINTS ALL IMMEDIATE")
    if commit:
        target.commit()
        print("已提交匯入。")
    else:
        target.rollback()
        print("演練通過，PostgreSQL 交易已回滾。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-env", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--commit", action="store_true", help="提交匯入。預設完成檢查後回滾")
    args = parser.parse_args()

    config = dotenv_values(args.source_env, interpolate=False)
    dsn = os.environ.get("MIGRATION_DATABASE_URL", "")
    if not dsn or conninfo_to_dict(dsn).get("sslmode") != "verify-full":
        parser.error("請在執行環境設定 MIGRATION_DATABASE_URL，並指定 sslmode=verify-full")
    missing = [key for key in ("MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")
               if not config.get(key)]
    if missing:
        parser.error("來源環境設定缺少 " + ", ".join(missing))

    try:
        with closing(pymysql.connect(
            host=config["MYSQL_HOST"], port=int(config.get("MYSQL_PORT") or "3306"),
            user=config["MYSQL_USER"], password=config["MYSQL_PASSWORD"],
            database=config["MYSQL_DATABASE"], charset="utf8mb4", connect_timeout=5,
        )) as source, closing(psycopg.connect(dsn, connect_timeout=8)) as target:
            copy_snapshot(source, target, args.commit)
    except (pymysql.Error, psycopg.Error) as error:
        # Constraints and COPY errors may contain lab data. Only print error identifiers.
        code = error.sqlstate if isinstance(error, psycopg.Error) else error.args[0]
        parser.exit(1, f"搬移中止：{type(error).__name__} ({code})\n")
    except ValueError as error:
        parser.exit(1, f"搬移中止：{error}\n")


if __name__ == "__main__":
    main()
