#!/usr/bin/env python3
"""Validate Ouroboros wikilinks in wiki/ and spec/ markdown files."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

SCAN_DIRS = ("wiki", "spec")
WIKILINK_PATTERN = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")


@dataclass(frozen=True)
class BrokenLink:
    source_file: Path
    target: str


def strip_code_fences(text: str) -> str:
    lines: list[str] = []
    in_fence = False
    fence_marker = ""

    for line in text.splitlines():
        stripped = line.lstrip()
        if not in_fence and (stripped.startswith("```") or stripped.startswith("~~~")):
            in_fence = True
            fence_marker = stripped[:3]
            lines.append("")
            continue

        if in_fence:
            if stripped.startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            lines.append("")
            continue

        lines.append(line)

    return "\n".join(lines)


def iter_markdown_files(workspace_root: Path) -> list[Path]:
    files: list[Path] = []
    for directory in SCAN_DIRS:
        root = workspace_root / directory
        if root.is_dir():
            files.extend(sorted(root.rglob("*.md")))
    return files


def resolve_target(workspace_root: Path, target: str) -> bool:
    target = target.strip()
    candidates = [workspace_root / target]

    if not Path(target).suffix:
        candidates.extend(
            [
                workspace_root / f"{target}.md",
                workspace_root / f"{target}.dsl",
            ]
        )

    return any(candidate.is_file() for candidate in candidates)


def scan_workspace(workspace_root: Path) -> list[BrokenLink]:
    broken: list[BrokenLink] = []
    for md_file in iter_markdown_files(workspace_root):
        text = strip_code_fences(md_file.read_text(encoding="utf-8"))
        for match in WIKILINK_PATTERN.finditer(text):
            target = match.group(1).strip()
            if target and not resolve_target(workspace_root, target):
                broken.append(BrokenLink(md_file, target))
    return broken


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python hooks/wikilink-integrity-guard.py <workspace-root>", file=sys.stderr)
        return 2

    workspace_root = Path(argv[1]).resolve()
    if not workspace_root.is_dir():
        print(f"Workspace root does not exist: {workspace_root}", file=sys.stderr)
        return 2

    broken = scan_workspace(workspace_root)
    if broken:
        print(f"Broken wikilinks: {len(broken)}")
        for item in broken:
            rel = item.source_file.relative_to(workspace_root)
            print(f"  {rel} -> [[{item.target}]]")
        return 2

    print("wikilink integrity ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
