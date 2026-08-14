#!/usr/bin/env python3
"""Scan Ouroboros wiki/spec pages for stale curated knowledge."""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

SCAN_DIRS = ("wiki", "spec")
FRONTMATTER_PATTERN = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
FIELD_PATTERN = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$")
HTML_UPDATED_PATTERN = re.compile(r"<!--\s*updated:\s*(\d{4}-\d{2}-\d{2})\s*-->")
HTML_STALENESS_PATTERN = re.compile(r"<!--\s*staleness:\s*(\d+)d\s*-->")
DEFAULT_STALENESS = {
    "entity": 30,
    "concept": 60,
    "pattern": 120,
    "comparison": 60,
    "c4": 90,
    "spec": 90,
    "schema": 90,
    "index": 90,
}


@dataclass(frozen=True)
class StalePage:
    file: Path
    updated: dt.date
    staleness_days: int
    days_since_update: int


@dataclass(frozen=True)
class BadPage:
    file: Path
    reason: str


@dataclass
class ScanResult:
    stale: list[StalePage] = field(default_factory=list)
    bad: list[BadPage] = field(default_factory=list)


def iter_markdown_files(workspace_root: Path) -> list[Path]:
    files: list[Path] = []
    for directory in SCAN_DIRS:
        root = workspace_root / directory
        if root.is_dir():
            files.extend(sorted(root.rglob("*.md")))
    return files


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER_PATTERN.search(text)
    if not match:
        return {}

    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        field = FIELD_PATTERN.match(line.strip())
        if field:
            fields[field.group(1)] = field.group(2)
    return fields


def parse_date(value: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def scan_workspace(workspace_root: Path, today: dt.date | None = None) -> ScanResult:
    today = today or dt.date.today()
    result = ScanResult()

    for md_file in iter_markdown_files(workspace_root):
        text = md_file.read_text(encoding="utf-8")
        fields = parse_frontmatter(text)

        updated_raw = fields.get("updated")
        html_updated = HTML_UPDATED_PATTERN.search(text)
        if not updated_raw and html_updated:
            updated_raw = html_updated.group(1)

        if not updated_raw:
            result.bad.append(BadPage(md_file, "missing updated field"))
            continue

        updated = parse_date(updated_raw)
        if updated is None:
            result.bad.append(BadPage(md_file, f"invalid updated date: {updated_raw}"))
            continue

        html_staleness = HTML_STALENESS_PATTERN.search(text)
        page_type = fields.get("type", "")
        staleness_days = (
            int(html_staleness.group(1))
            if html_staleness
            else DEFAULT_STALENESS.get(page_type, 90)
        )
        days_since_update = (today - updated).days

        if days_since_update > staleness_days:
            result.stale.append(
                StalePage(md_file, updated, staleness_days, days_since_update)
            )

    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace_root")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv[1:])

    workspace_root = Path(args.workspace_root).resolve()
    if not workspace_root.is_dir():
        print(f"Workspace root does not exist: {workspace_root}", file=sys.stderr)
        return 2

    result = scan_workspace(workspace_root)

    if result.stale:
        print(f"Stale pages: {len(result.stale)}")
        for item in result.stale:
            rel = item.file.relative_to(workspace_root)
            print(
                f"  {rel}: updated {item.updated.isoformat()}, "
                f"staleness {item.staleness_days}d, age {item.days_since_update}d"
            )
    else:
        print("staleness ok")

    if result.bad:
        print(f"Pages with missing or invalid metadata: {len(result.bad)}")
        for item in result.bad:
            rel = item.file.relative_to(workspace_root)
            print(f"  {rel}: {item.reason}")

    if args.strict and (result.stale or result.bad):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
