#!/usr/bin/env python3
"""Dispatch every workflow whose cron slot has passed without a run.

GitHub's `schedule` trigger has run hours late, or not at all, for this repository, so the `tick` workflow runs this
about once an hour. Each argument is "workflow-file=cron[;cron...]", in GitHub's UTC cron syntax. For each workflow it
finds the latest slot in the last three hours and dispatches the workflow unless a run of it has started since that
slot, so nothing runs twice for one slot.
"""

import datetime as dt
import json
import subprocess
import sys

LOOKBACK = dt.timedelta(hours=3)


def values(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        span, _, step = part.partition("/")
        if span == "*":
            a, b = lo, hi
        elif "-" in span:
            a, b = (int(x) for x in span.split("-"))
        else:
            a = int(span)
            b = hi if step else a
        out.update(range(a, b + 1, int(step or 1)))
    return out


def matcher(expr: str):
    minute, hour, dom, month, dow = expr.split()
    minutes, hours = values(minute, 0, 59), values(hour, 0, 23)
    days, months = values(dom, 1, 31), values(month, 1, 12)
    weekdays = {d % 7 for d in values(dow, 0, 7)}  # 0 and 7 are both Sunday

    def match(t: dt.datetime) -> bool:
        if t.minute not in minutes or t.hour not in hours or t.month not in months:
            return False
        day_ok, weekday_ok = t.day in days, t.isoweekday() % 7 in weekdays
        # Standard cron: when both day fields are restricted, either one matching is enough.
        if dom != "*" and dow != "*":
            return day_ok or weekday_ok
        return day_ok and weekday_ok

    return match


def latest_slot(crons: list[str], now: dt.datetime) -> dt.datetime | None:
    matchers = [matcher(c) for c in crons]
    t = now.replace(second=0, microsecond=0)
    while now - t <= LOOKBACK:
        if any(m(t) for m in matchers):
            return t
        t -= dt.timedelta(minutes=1)
    return None


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def main() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    failed = False
    for arg in sys.argv[1:]:
        workflow, _, crons = arg.partition("=")
        slot = latest_slot([c.strip() for c in crons.split(";")], now)
        if slot is None:
            print(f"{workflow}: no slot in the last {LOOKBACK}")
            continue
        runs = json.loads(gh("run", "list", "--workflow", workflow, "--limit", "1", "--json", "createdAt"))
        last = dt.datetime.fromisoformat(runs[0]["createdAt"].replace("Z", "+00:00")) if runs else None
        seen = f"{last:%Y-%m-%d %H:%M}" if last else "never"
        if last and last >= slot:
            print(f"{workflow}: slot {slot:%Y-%m-%d %H:%M} already served by the run at {seen}")
            continue
        try:
            gh("workflow", "run", workflow)
            print(f"{workflow}: slot {slot:%Y-%m-%d %H:%M} had no run (last {seen}), dispatched")
        except subprocess.CalledProcessError as e:
            failed = True
            print(f"{workflow}: dispatch failed: {e.stderr.strip()}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
