"""Westgard 多規則品管判讀邏輯。

提供針對單筆與一組（同儀器、同檢驗項目、同品管濃度）品管結果的
Westgard rules 判讀。回傳違反的規則清單與最終狀態。

支援規則：
  1-2s : 單點超過 ±2SD（僅警告 / warning，非拒收）
  1-3s : 單點超過 ±3SD（拒收）
  2-2s : 連續 2 點同方向超過 ±2SD（拒收）
  R-4s : 同一批內兩點差距超過 4SD（拒收）
  4-1s : 連續 4 點同方向超過 ±1SD（拒收）
  10x  : 連續 10 點落在平均值同一側（拒收）
"""
from __future__ import annotations

from typing import Iterable


# 會造成「拒收 / Fail」的規則
REJECTION_RULES = {"1-3s", "2-2s", "R-4s", "4-1s", "10x"}


def evaluate_point(z_score: float | None) -> list[str]:
    """只用單一點即可判斷的規則（1-2s / 1-3s）。"""
    rules: list[str] = []
    if z_score is None:
        return rules
    az = abs(z_score)
    if az > 3:
        rules.append("1-3s")
    elif az > 2:
        rules.append("1-2s")
    return rules


def evaluate_series(z_scores: list[float]) -> list[str]:
    """針對一組依時間排序的 z-score 序列做多規則判讀。

    `z_scores` 為同一儀器 / 檢驗項目 / 濃度的歷史 z-score，
    最後一筆為最新的結果。回傳此最新結果觸發的規則。
    """
    rules: set[str] = set()
    if not z_scores:
        return []

    latest = z_scores[-1]

    # 單點規則
    rules.update(evaluate_point(latest))

    # 2-2s：最新兩點同方向且皆 > 2SD
    if len(z_scores) >= 2:
        a, b = z_scores[-2], z_scores[-1]
        if abs(a) > 2 and abs(b) > 2 and (a > 0) == (b > 0):
            rules.add("2-2s")

    # R-4s：最新兩點差距 > 4SD（範圍規則）
    if len(z_scores) >= 2:
        if abs(z_scores[-1] - z_scores[-2]) > 4:
            rules.add("R-4s")

    # 4-1s：連續 4 點同方向且皆 > 1SD
    if len(z_scores) >= 4:
        last4 = z_scores[-4:]
        if all(z > 1 for z in last4) or all(z < -1 for z in last4):
            rules.add("4-1s")

    # 10x：連續 10 點落在平均同側
    if len(z_scores) >= 10:
        last10 = z_scores[-10:]
        if all(z > 0 for z in last10) or all(z < 0 for z in last10):
            rules.add("10x")

    return sorted(rules)


def status_from_rules(rules: Iterable[str]) -> str:
    """依違反規則決定品管狀態。"""
    rule_set = set(rules)
    if rule_set & REJECTION_RULES:
        return "Fail"
    if "1-2s" in rule_set:
        return "Warning"
    return "Pass"
