#!/usr/bin/env python3
"""tools/publish.py — Desk Puzzle 2D publish helper.

Usage:
    python3 tools/publish.py           # dry run: validate + print checklist
    python3 tools/publish.py --apply   # validate + rewrite index.html and
                                       # write puzzles/.local-puzzle-fallback.js
    python3 tools/publish.py --commit  # implies --apply, then git-commits index.html
                                       # with message "release: <title> (<date>) v<N>"

Exit codes:
    0 — validation passed (dry run printed; apply/commit applied changes)
    1 — validation failed (puzzle has structural problems)
"""

import argparse
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_JSON = os.path.join(REPO_ROOT, "puzzles", "index.json")
INDEX_HTML = os.path.join(REPO_ROOT, "index.html")
FALLBACK_JS = os.path.join(REPO_ROOT, "puzzles", ".local-puzzle-fallback.js")

VALID_ZONES = {"corkboard", "folder", "rack", "tubes", "photo", "rx"}
MACHINE_ZONES = {"rack": "scope", "tubes": "lightbox"}

# ── Validation ────────────────────────────────────────────────────────────────

def _validate_image_field(value, owner, field_label):
    """Return a list of error strings for an image field value.

    A value is valid when it is:
      - a non-empty data URI (starts with 'data:'), OR
      - a non-empty relative path whose file exists under REPO_ROOT.
    An empty value is allowed (field absent / no image).
    """
    if not value:
        return [f'item "{owner}" {field_label} is missing or empty']
    if value.startswith("data:"):
        return []  # embedded data URI — always valid
    # Relative path: must resolve to an existing file
    candidate = os.path.join(REPO_ROOT, value)
    if not os.path.isfile(candidate):
        return [f'item "{owner}" {field_label} is a relative path but file not found: {value!r}']
    return []


def validate_puzzle(puzzle, filename):
    """Mirror caseProblems() from game.js and add the extra audit checks.
    Returns (errors, warnings) as lists of strings."""
    errors = []
    warnings = []

    # Basic shape
    items = puzzle.get("items")
    groups = puzzle.get("groups")

    if not isinstance(items, list) or len(items) != 16:
        errors.append(f"expected 16 items, got {len(items) if isinstance(items, list) else 'none'}")
    if not isinstance(groups, list) or len(groups) != 4:
        errors.append(f"expected 4 groups, got {len(groups) if isinstance(groups, list) else 'none'}")

    if errors:
        return errors, warnings

    # Unique item ids
    item_ids = [i.get("id") for i in items if i.get("id")]
    if len(set(item_ids)) != len(items):
        errors.append("duplicate item ids")

    id_set = set(item_ids)

    # Group coverage
    grouped = set()
    tiers_seen = []
    for g in groups:
        g_name = g.get("name") or "(unnamed group)"
        item_ids_g = g.get("itemIds") or []
        if len(item_ids_g) != 4:
            errors.append(f'group "{g_name}" has {len(item_ids_g)} itemIds (expected 4)')
        for iid in item_ids_g:
            if iid not in id_set:
                errors.append(f'group "{g_name}" references unknown item "{iid}"')
            if iid in grouped:
                errors.append(f'item "{iid}" appears in two groups')
            grouped.add(iid)

        # tier must be integer 1-4 and unique across groups
        tier = g.get("tier")
        if not isinstance(tier, int) or tier not in (1, 2, 3, 4):
            errors.append(f'group "{g_name}" tier must be an integer 1-4, got {tier!r}')
        else:
            if tier in tiers_seen:
                errors.append(f'tier {tier} is used by more than one group')
            tiers_seen.append(tier)

        # name/explanation non-empty
        if not g.get("name"):
            errors.append(f"group at tier {g.get('tier', '?')} has an empty name")
        if not g.get("explanation"):
            errors.append(f'group "{g_name}" has an empty explanation')

        # article blocks
        article = g.get("article")
        if article is not None:
            if not isinstance(article, list):
                errors.append(f'group "{g_name}" article must be a list of blocks')
            else:
                for bi, block in enumerate(article):
                    btype = block.get("type") if isinstance(block, dict) else None
                    if btype not in ("heading", "text", "image"):
                        errors.append(f'group "{g_name}" article block {bi+1} has invalid type {btype!r}')
                    elif btype == "image":
                        errors.extend(_validate_image_field(
                            block.get("src"), g_name, f"article image block {bi+1} src"
                        ))

        # anki.nids must be positive integers if present
        anki = g.get("anki")
        if anki is not None:
            nids = anki.get("nids")
            if nids is not None:
                if not isinstance(nids, list):
                    errors.append(f'group "{g_name}" anki.nids must be a list')
                else:
                    for nid in nids:
                        if not isinstance(nid, int) or nid <= 0:
                            errors.append(f'group "{g_name}" anki.nids contains invalid value {nid!r} (must be positive integer)')

    if len(grouped) != 16:
        errors.append(f"groups cover {len(grouped)}/16 items")

    # Per-item checks
    machines_declared = puzzle.get("machines")
    if machines_declared is not None and not isinstance(machines_declared, list):
        errors.append('"machines" must be a list (e.g. ["scope","lightbox"])')
    machines = machines_declared if isinstance(machines_declared, list) else ["scope", "lightbox"]

    for item in items:
        iid = item.get("id", "?")
        zone = item.get("zone")
        if zone not in VALID_ZONES:
            errors.append(f'item "{iid}" has unknown zone "{zone}"')
        else:
            needed_machine = MACHINE_ZONES.get(zone)
            if needed_machine and needed_machine not in machines:
                errors.append(f'item "{iid}" zone "{zone}" needs machine "{needed_machine}" but it is not declared')

        # label non-empty
        if not item.get("label"):
            errors.append(f'item "{iid}" has an empty label')

        # info.title required for photo/rack/tubes
        if zone in ("photo", "rack", "tubes"):
            info = item.get("info")
            if not isinstance(info, dict) or not info.get("title"):
                errors.append(f'item "{iid}" zone "{zone}" requires info.title')

        # image fields: valid if data URI or relative path to existing file
        info = item.get("info")
        if isinstance(info, dict) and info.get("image"):
            errors.extend(_validate_image_field(
                info["image"], iid, "info.image"
            ))
        scope = item.get("scope")
        if isinstance(scope, dict) and scope.get("image"):
            errors.extend(_validate_image_field(
                scope["image"], iid, "scope.image"
            ))

    # Size warning
    try:
        size = os.path.getsize(os.path.join(REPO_ROOT, "puzzles", filename))
        if size > 1_000_000:
            warnings.append(f"puzzle file is {size:,} bytes (> 1 MB) — consider trimming data URIs")
    except OSError:
        pass

    return errors, warnings


# ── index.html rewriting ──────────────────────────────────────────────────────

def read_html():
    with open(INDEX_HTML, encoding="utf-8") as f:
        return f.read()


def current_version(html):
    """Extract the current ?v=N value from styles.css or game.js tag."""
    m = re.search(r'styles\.css\?v=(\d+)', html)
    if m:
        return int(m.group(1))
    m = re.search(r'(?:src/main|game)\.js\?v=(\d+)', html)
    if m:
        return int(m.group(1))
    return 0


def rewrite_html(html, entry, new_v):
    """Rewrite the five puzzle-specific strings and bump cache-bust version."""
    title = entry["title"]
    desc = f"{title} - a pathology desk puzzle: sort 16 clues into 4 groups."
    short_desc = f"Sort 16 pathology clues into 4 hidden groups."

    old_v = current_version(html)

    html = re.sub(r'<title>[^<]*</title>', f'<title>{title}</title>', html)
    html = re.sub(
        r'<meta name="description" content="[^"]*"',
        f'<meta name="description" content="{desc}"',
        html,
    )
    html = re.sub(
        r'(<meta property="og:title" content=")[^"]*(")',
        rf'\g<1>{title}\g<2>',
        html,
    )
    html = re.sub(
        r'(<meta name="twitter:title" content=")[^"]*(")',
        rf'\g<1>{title}\g<2>',
        html,
    )
    # Also update og/twitter descriptions to the short form
    html = re.sub(
        r'(<meta property="og:description" content=")[^"]*(")',
        rf'\g<1>{short_desc}\g<2>',
        html,
    )
    html = re.sub(
        r'(<meta name="twitter:description" content=")[^"]*(")',
        rf'\g<1>{short_desc}\g<2>',
        html,
    )

    # Bump ?v= on both stylesheet and script (keep them equal)
    html = re.sub(r'styles\.css\?v=\d+', f'styles.css?v={new_v}', html)
    html = re.sub(r'src/main\.js\?v=\d+', f'src/main.js?v={new_v}', html)
    html = re.sub(r'game\.js\?v=\d+', f'game.js?v={new_v}', html)
    # Self-check: every ?v= on the stylesheet and entry script must now agree.
    versions = set(re.findall(r'(?:styles\.css|src/main\.js|game\.js)\?v=(\d+)', html))
    if versions != {str(new_v)}:
        raise SystemExit(f'[FAIL] version tags disagree after bump: {sorted(versions)}')

    return html, old_v


def write_html(html):
    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(html)


# ── .local-puzzle-fallback.js ─────────────────────────────────────────────────

def write_fallback_js(puzzle):
    """Write the gitignored file:// preview helper."""
    payload = json.dumps(puzzle, indent=2, ensure_ascii=False)
    content = (
        "// Generated by tools/publish.py --apply — do not edit by hand.\n"
        "// This file is gitignored. Re-run publish.py --apply to regenerate.\n"
        f"window.DP2D_LOCAL_PUZZLE = {payload};\n"
    )
    with open(FALLBACK_JS, "w", encoding="utf-8") as f:
        f.write(content)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Desk Puzzle 2D publish helper")
    parser.add_argument("--apply", action="store_true",
                        help="rewrite index.html and write .local-puzzle-fallback.js")
    parser.add_argument("--commit", action="store_true",
                        help="implies --apply; also git-commits index.html")
    args = parser.parse_args()
    if args.commit:
        args.apply = True

    ok = True

    # 1. Load registry
    print("=== Desk Puzzle 2D publish checklist ===\n")
    try:
        with open(INDEX_JSON, encoding="utf-8") as f:
            registry = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[FAIL] Could not read puzzles/index.json: {e}")
        sys.exit(1)

    current_id = registry.get("current")
    puzzles = registry.get("puzzles", [])
    current_entry = next((p for p in puzzles if p.get("id") == current_id), None)

    if not current_id:
        print("[FAIL] puzzles/index.json has no 'current' field")
        ok = False
    elif not current_entry:
        print(f"[FAIL] 'current' id '{current_id}' not found in puzzles list")
        ok = False
    else:
        print(f"[OK]   current = {current_id}")

    if not ok:
        sys.exit(1)

    # 2. Verify puzzle file exists
    puzzle_file = current_entry.get("file", current_id + ".json")
    puzzle_path = os.path.join(REPO_ROOT, "puzzles", puzzle_file)
    if not os.path.isfile(puzzle_path):
        print(f"[FAIL] Puzzle file not found: puzzles/{puzzle_file}")
        sys.exit(1)
    print(f"[OK]   puzzle file: puzzles/{puzzle_file}")

    try:
        with open(puzzle_path, encoding="utf-8") as f:
            puzzle = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[FAIL] Could not parse puzzles/{puzzle_file}: {e}")
        sys.exit(1)

    # 3. Validate puzzle
    errors, warnings = validate_puzzle(puzzle, puzzle_file)
    for w in warnings:
        print(f"[WARN] {w}")
    if errors:
        print(f"\n[FAIL] Puzzle validation failed ({len(errors)} error(s)):")
        for e in errors:
            print(f"       - {e}")
        sys.exit(1)
    print(f"[OK]   validation passed (0 errors, {len(warnings)} warning(s))")

    # 4. Inspect index.html changes
    html = read_html()
    old_v = current_version(html)
    new_v = old_v + 1
    new_html, _ = rewrite_html(html, current_entry, new_v)

    title = current_entry["title"]
    date = current_entry.get("date", "")

    print()
    print("--- Changes to index.html ---")
    print(f"  <title>          -> {title}")
    print(f"  og:title         -> {title}")
    print(f"  twitter:title    -> {title}")
    print(f"  meta description -> {title} - a pathology desk puzzle: sort 16 clues into 4 groups.")
    print(f"  ?v=              -> {old_v} -> {new_v}")
    print(f"  .local-puzzle-fallback.js: will {'overwrite' if os.path.exists(FALLBACK_JS) else 'create'}")
    print()

    if not args.apply:
        print("[dry run] Pass --apply to write changes, --commit to also commit.")
        print()
        return

    # 5. Write
    write_html(new_html)
    print(f"[WRITE] index.html updated (v{old_v} -> v{new_v})")

    write_fallback_js(puzzle)
    print(f"[WRITE] puzzles/.local-puzzle-fallback.js written")

    if not args.commit:
        return

    # 6. Commit
    commit_msg = f"release: {title} ({date}) v{new_v}"
    try:
        subprocess.run(
            ["git", "add", "index.html"],
            cwd=REPO_ROOT, check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=REPO_ROOT, check=True, capture_output=True,
        )
        print(f"[GIT]   committed: {commit_msg}")
        print()
        print("Run to publish:")
        print("  git push origin main")
    except subprocess.CalledProcessError as e:
        print(f"[FAIL] git error: {e.stderr.decode().strip()}")
        sys.exit(1)


if __name__ == "__main__":
    main()
