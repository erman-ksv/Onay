#!/usr/bin/env python3
"""Persist factual in-session snapshots; this does not deliver notifications."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time


def snapshot():
    root = Path(__file__).resolve().parent
    state = json.loads((root / "state.json").read_text())
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root.parent, text=True).strip()
    changed = subprocess.check_output(["git", "status", "--short"], cwd=root.parent, text=True).strip()
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    rows = [f"| {a['role']} | {a['task']} | {a['status']} | UNKNOWN |" for a in state["agents"]]
    report = "\n".join([
        "# ONAY — AI TEAM REPORT", "", f"Время: {now.isoformat()}", "Проект: ONAY", "PR: #110", f"HEAD: {head}",
        "", "| Агент | Задача | Статус из state.json | Прогресс |", "|---|---|---|---|", *rows,
        "", f"Состояние агентов обновлено: {state['updatedAt']}; snapshot не проверяет живые процессы.",
        "", "За период: Git baseline и данные задач см. state.json; автоматический snapshot не подтверждает новые исправления.",
        f"Тесты локально: {state['tests']}. Коммиты команды: {state['commits']}.",
        "CI baseline: 7 SUCCESS, 3 SKIPPED, 1 FAILURE (APK119 publication HTTP403; native acceptance SUCCESS; build SKIPPED).",
        "Общая готовность Onay: UNKNOWN — подтверждённый полный чек-лист ещё не составлен.",
        "", "Лимиты: бюджет UNKNOWN; использовано UNKNOWN; риск остановки UNKNOWN; 7 слотов включая orchestrator.",
        "Продолжение после сессии не настроено. Внешняя доставка каждые 5 минут BLOCKED: Automations допускает минимум 10 минут, 6 запусков/час. Этот файл сам по себе не доказывает доставку владельцу.",
        "", "Следующие действия: аудит независимых направлений, тесты, review, интеграция подтверждённых исправлений в PR110.",
        "", "Изменённые файлы (git status):", "```", changed, "```", "",
    ])
    path = root / "reports" / f"{stamp}.md"
    path.write_text(report)
    state["lastSuccessfulReport"] = {"path": str(path.relative_to(root.parent)), "savedAt": now.isoformat(), "delivered": False}
    (root / "state.json").write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    print(str(path), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true", help="Persist every 300 seconds while this session process runs")
    args = parser.parse_args()
    while True:
        snapshot()
        if not args.watch:
            break
        time.sleep(300)
