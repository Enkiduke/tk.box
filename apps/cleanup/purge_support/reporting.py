"""Run results, grouped candidate summaries, and the per-title status tk.box lists (Admin > Clean Up > Status)."""

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class RunReport:
    processed: int = 0
    deleted: int = 0
    planned: int = 0
    failed: int = 0
    skipped_missing_added_at: int = 0
    not_found: int = 0
    protected: int = 0
    kept: int = 0
    evaluation_complete: bool = True
    leaving_items: list = field(default_factory=list)
    delete_summary: dict = field(default_factory=dict)
    leaving_summary: dict = field(default_factory=dict)
    season_summary: dict = field(default_factory=dict)
    # One entry per movie, show or season looked at: what happens to it and when.
    items: list = field(default_factory=list)


def library_name(item):
    name = getattr(item, "librarySectionTitle", None)
    if not name:
        try:
            name = item.section().title
        except Exception:
            name = "Unknown Library"
    return name


def add_entry(summary, item, entry):
    summary.setdefault(library_name(item), []).append(entry)


def add_status(report, item, kind, status, *, title=None, rule=None, reason="", library=None):
    """`status` is due, leaving, kept, protected, not_found or error; `kind` is movie, show or season."""
    year = getattr(item, "year", None) if item is not None and kind != "season" else None
    report.items.append({
        "title": title or getattr(item, "title", None) or "Unknown Title",
        "year": year if isinstance(year, int) else None,
        "kind": kind,
        "library": library or (library_name(item) if item is not None else ""),
        "status": status,
        "rule": rule.name if rule else None,
        "reason": rule.reason if rule else reason,
        "deletion_date": rule.deletion_date.isoformat() if rule else None,
    })


def write_status(report, path, dry_run):
    """Written whole and then moved into place, so tk.box never reads a half-written file."""
    path = Path(path)
    data = {"updated": datetime.now(timezone.utc).isoformat(), "dry_run": dry_run, "complete": report.evaluation_complete,
            "items": report.items}
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def log_section(title, summary):
    logger.info("%s:%s", title, "" if summary else " none")
    for library_name in sorted(summary):
        entries = summary[library_name]
        logger.info("  %s (%s):", library_name, len(entries))
        for entry in entries:
            logger.info("    - %s", entry)


def log_report(report, dry_run):
    logger.info("Summary: Processed=%s, Deleted=%s, DryRun=%s, Failed=%s, Skipped(Missing AddedAt)=%s, "
                "NotFound=%s, Protected=%s, Kept=%s",
                report.processed, report.deleted, report.planned, report.failed,
                report.skipped_missing_added_at, report.not_found, report.protected, report.kept)
    log_section("Delete Candidates By Library" + (" (DRY RUN)" if dry_run else ""), report.delete_summary)
    log_section("Leaving Soon Candidates By Library", report.leaving_summary)
    log_section("Season-Level Upcoming Deletions By Library (not added to collection)", report.season_summary)
