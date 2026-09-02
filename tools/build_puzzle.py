#!/usr/bin/env python3
"""tools/build_puzzle.py — Build a puzzle JSON from a YAML (or JSON) author spec.

Usage:
    python3 tools/build_puzzle.py puzzles/_spec/<name>.yaml [options]

Options:
    --apply            Write puzzle JSON and images, update puzzles/index.json.
    --set-current      Also point index.json "current" at the new puzzle id
                       (implies --apply).
    --quality INT      WebP quality for converted images (default: 85).
    --max-side INT     Resize if the long side exceeds this; never upscales
                       (default: 640).
    --out-dir PATH     Write outputs to PATH instead of puzzles/ (for testing).

Dry run (no --apply): parses the spec, derives all ids and defaults, resolves
every source image, runs structural validation, and prints a checklist. Exits 1
on any error (missing image source, structural validation failure).

With --apply: additionally converts/copies images to WebP and writes the puzzle
JSON and index entry. Idempotent: re-running on the same spec produces byte-
identical JSON.

Spec format: YAML (primary). If PyYAML is not installed, use a .json twin with
the same structure — the tool accepts both based on file extension. Install
PyYAML with: pip install pyyaml

Slug rule: lowercase, ASCII letters/digits, hyphens only, collapse consecutive
hyphens, strip leading/trailing hyphens.
Puzzle id: slug(title minus a trailing "Puzzle" word) + "-" + date.
Group id defaults: "g-" + slug(group name).
Item id defaults: slug(item label).
Item title defaults to item label.
Machines: derived from zones used (rack -> scope, tubes -> lightbox).
"""

import argparse
import copy
import json
import os
import re
import shutil
import sys
from io import BytesIO

# ── Dependency checks ────────────────────────────────────────────────────────

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required. Install with: pip install Pillow", file=sys.stderr)
    sys.exit(1)

try:
    import yaml
    _YAML_AVAILABLE = True
except ImportError:
    _YAML_AVAILABLE = False

# ── Paths ────────────────────────────────────────────────────────────────────

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_JSON = os.path.join(REPO_ROOT, "puzzles", "index.json")

# ── Import shared validator from publish.py ──────────────────────────────────

sys.path.insert(0, os.path.join(REPO_ROOT, "tools"))
try:
    from publish import validate_puzzle as _validate_puzzle
    _VALIDATOR_IMPORTED = True
except ImportError:
    _VALIDATOR_IMPORTED = False
    _validate_puzzle = None

# ── Slug / ID helpers ────────────────────────────────────────────────────────

def slugify(s):
    """Lowercase, ASCII letters/digits/hyphens, collapsed, stripped."""
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = re.sub(r'-+', '-', s)
    return s.strip('-')


def puzzle_id_from_title_date(title, date):
    """Derive puzzle id: slug(title minus trailing 'Puzzle') + '-' + date."""
    clean = re.sub(r'\s+puzzle\s*$', '', title, flags=re.IGNORECASE).strip()
    return slugify(clean) + '-' + date


# ── Image processing (mirrors externalize_images.py) ────────────────────────

def process_image(raw_bytes, max_side, quality, method=4):
    """Decode raw image bytes, optionally resize (never upscale), return WebP bytes."""
    img = Image.open(BytesIO(raw_bytes))
    w, h = img.size
    long_side = max(w, h)
    if long_side > max_side:
        scale = max_side / long_side
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        img = img.resize((new_w, new_h), Image.LANCZOS)
    out = BytesIO()
    img.save(out, "WEBP", quality=quality, method=method)
    return out.getvalue()


def copy_or_convert_image(src_path, out_path, max_side, quality):
    """Write src image to out_path as WebP.

    If src is already .webp and its long side is at or below max_side, copy
    the file bytes unchanged (exact byte identity, no re-encode).
    Otherwise decode, optionally resize, and encode to WebP.
    """
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if src_path.lower().endswith('.webp'):
        img = Image.open(src_path)
        if max(img.size) <= max_side:
            shutil.copy2(src_path, out_path)
            return
    with open(src_path, 'rb') as f:
        raw = f.read()
    webp_bytes = process_image(raw, max_side, quality)
    with open(out_path, 'wb') as f:
        f.write(webp_bytes)


# ── Spec loading ─────────────────────────────────────────────────────────────

def load_spec(spec_path):
    """Load a .yaml or .json spec file and return the parsed dict."""
    ext = os.path.splitext(spec_path)[1].lower()
    if ext in ('.yaml', '.yml'):
        if not _YAML_AVAILABLE:
            print(
                "ERROR: PyYAML is not installed.\n"
                "  Install it with: pip install pyyaml\n"
                "  Or use a .json spec file with the same structure.",
                file=sys.stderr,
            )
            sys.exit(1)
        with open(spec_path, encoding='utf-8') as f:
            return yaml.safe_load(f)
    elif ext == '.json':
        with open(spec_path, encoding='utf-8') as f:
            return json.load(f)
    else:
        print(f"ERROR: Unsupported spec extension: {ext!r}. Use .yaml or .json", file=sys.stderr)
        sys.exit(1)


# ── Spec → puzzle data ───────────────────────────────────────────────────────

ZONE_TO_MACHINE = {'rack': 'scope', 'tubes': 'lightbox'}
VALID_ZONES = {'corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx'}


def build_puzzle_data(spec, spec_dir, puzzle_id, quality, max_side, out_puzzle_dir):
    """Parse spec and return (puzzle_dict, image_plan, source_errors).

    puzzle_dict:   the complete puzzle JSON structure with page-relative image paths.
    image_plan:    list of (src_abs_path, out_abs_path, page_rel_path) tuples.
    source_errors: list of error strings for missing source image files.
    """
    images_folder = spec.get('images', '')
    if images_folder:
        images_dir = os.path.normpath(os.path.join(spec_dir, images_folder))
    else:
        images_dir = spec_dir

    title = spec.get('title', '')
    date = spec.get('date', '')
    if isinstance(date, object) and not isinstance(date, str):
        # YAML may parse dates as date objects
        date = str(date)

    spec_groups = spec.get('groups', [])
    source_errors = []
    image_plan = []  # (src_abs, out_abs, page_rel)
    machines_needed = []  # insertion-order list for deterministic output

    groups_out = []
    items_out = []

    for sg in spec_groups:
        g_name = sg.get('name', '')
        g_id = sg.get('id') or ('g-' + slugify(g_name))
        g_tier = sg.get('tier')
        g_explanation = sg.get('explanation', '').strip()
        g_anki_raw = sg.get('anki')
        g_article = sg.get('article')

        # Build anki block
        g_anki = None
        if g_anki_raw is not None:
            if isinstance(g_anki_raw, list):
                g_anki = {'nids': [int(n) for n in g_anki_raw]}
            elif isinstance(g_anki_raw, dict):
                # Already in {nids:[...]} form (JSON twin case)
                g_anki = g_anki_raw

        item_ids_for_group = []

        for si in sg.get('items', []):
            label = si.get('label', '')
            item_id = si.get('id') or slugify(label)
            item_title = si.get('title') or label
            zone = si.get('zone', '')
            text = si.get('text', '')

            if zone in ZONE_TO_MACHINE:
                m = ZONE_TO_MACHINE[zone]
                if m not in machines_needed:
                    machines_needed.append(m)

            # info block
            info = {'title': item_title, 'text': text}

            # info.image (photo, tubes, or rack with image)
            image_file = si.get('image')
            if image_file:
                src_abs = os.path.join(images_dir, image_file)
                out_filename = f'{item_id}-info.webp'
                out_abs = os.path.join(out_puzzle_dir, out_filename)
                page_rel = f'puzzles/{puzzle_id}/{out_filename}'
                if not os.path.isfile(src_abs):
                    source_errors.append(f'item "{item_id}" info image not found: {src_abs}')
                else:
                    image_plan.append((src_abs, out_abs, page_rel))
                info['image'] = page_rel

            # scope.image (rack zone)
            scope_image_file = si.get('scope_image')
            scope = None
            if scope_image_file:
                src_abs = os.path.join(images_dir, scope_image_file)
                out_filename = f'{item_id}-scope.webp'
                out_abs = os.path.join(out_puzzle_dir, out_filename)
                page_rel = f'puzzles/{puzzle_id}/{out_filename}'
                if not os.path.isfile(src_abs):
                    source_errors.append(f'item "{item_id}" scope image not found: {src_abs}')
                else:
                    image_plan.append((src_abs, out_abs, page_rel))
                scope = {'image': page_rel}

            item_obj = {
                'id': item_id,
                'label': label,
                'zone': zone,
                'info': info,
            }
            if scope:
                item_obj['scope'] = scope

            items_out.append(item_obj)
            item_ids_for_group.append(item_id)

        group_obj = {
            'id': g_id,
            'name': g_name,
            'tier': g_tier,
            'explanation': g_explanation,
        }
        if g_anki is not None:
            group_obj['anki'] = g_anki
        if g_article is not None:
            group_obj['article'] = g_article
        group_obj['itemIds'] = item_ids_for_group

        groups_out.append(group_obj)

    machines_list = machines_needed  # first-encounter order from spec items

    puzzle = {
        'id': puzzle_id,
        'title': title,
        'date': date,
        'machines': machines_list,
        'groups': groups_out,
        'items': items_out,
    }

    return puzzle, image_plan, source_errors


# ── Validation wrapper ────────────────────────────────────────────────────────

def run_validation(puzzle, puzzle_id, dry_run):
    """Run validate_puzzle from publish.py.

    During dry run, image-file-not-found errors are separated and shown as
    informational (since output images don't exist yet). Structural errors
    always count toward the exit code.

    Returns (structural_errors, image_errors, warnings).
    """
    if not _VALIDATOR_IMPORTED:
        return ['Could not import validate_puzzle from tools/publish.py'], [], []

    filename = f'{puzzle_id}.json'
    errors, warnings = _validate_puzzle(puzzle, filename)

    if not dry_run:
        return errors, [], warnings

    # Separate image-path errors from structural errors
    image_errors = [e for e in errors if 'file not found' in e or 'is missing or empty' in e]
    structural_errors = [e for e in errors if e not in image_errors]
    return structural_errors, image_errors, warnings


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Build a puzzle JSON from a YAML/JSON author spec.'
    )
    parser.add_argument('spec', help='Path to the spec file (.yaml or .json)')
    parser.add_argument('--apply', action='store_true',
                        help='Write outputs (implies nothing by itself; use with --set-current to also update current).')
    parser.add_argument('--set-current', action='store_true',
                        help='Point puzzles/index.json "current" at the new puzzle id (implies --apply).')
    parser.add_argument('--quality', type=int, default=85, help='WebP quality (default: 85)')
    parser.add_argument('--max-side', type=int, default=640,
                        help='Max long side in pixels; never upscales (default: 640)')
    parser.add_argument('--out-dir', default=None,
                        help='Write outputs to this directory instead of the repo puzzles/ folder.')
    args = parser.parse_args()

    if args.set_current:
        args.apply = True

    spec_path = os.path.abspath(args.spec)
    if not os.path.isfile(spec_path):
        print(f'ERROR: Spec file not found: {spec_path}', file=sys.stderr)
        sys.exit(1)

    spec_dir = os.path.dirname(spec_path)
    spec = load_spec(spec_path)

    title = spec.get('title', '')
    date = spec.get('date', '')
    if not isinstance(date, str):
        date = str(date)

    if not title:
        print('ERROR: Spec missing "title" field.', file=sys.stderr)
        sys.exit(1)
    if not date:
        print('ERROR: Spec missing "date" field.', file=sys.stderr)
        sys.exit(1)

    puzzle_id = puzzle_id_from_title_date(title, date)

    # Determine output directories
    if args.out_dir:
        out_root = os.path.abspath(args.out_dir)
        out_puzzle_dir = os.path.join(out_root, puzzle_id)
        out_json_path = os.path.join(out_root, f'{puzzle_id}.json')
        out_index_path = os.path.join(out_root, 'index.json')
    else:
        out_root = os.path.join(REPO_ROOT, 'puzzles')
        out_puzzle_dir = os.path.join(out_root, puzzle_id)
        out_json_path = os.path.join(out_root, f'{puzzle_id}.json')
        out_index_path = INDEX_JSON

    dry_run = not args.apply

    print('=== build_puzzle.py checklist ===')
    print(f'  Spec:       {os.path.relpath(spec_path, REPO_ROOT)}')
    print(f'  Puzzle id:  {puzzle_id}')
    print(f'  Title:      {title}')
    print(f'  Date:       {date}')
    print(f'  Mode:       {"DRY RUN" if dry_run else "APPLY"}')
    if args.out_dir:
        print(f'  Out dir:    {out_root}')
    print()

    # Build puzzle data
    puzzle, image_plan, source_errors = build_puzzle_data(
        spec, spec_dir, puzzle_id, args.quality, args.max_side, out_puzzle_dir
    )

    # Counts
    n_groups = len(puzzle.get('groups', []))
    n_items = len(puzzle.get('items', []))
    machines = puzzle.get('machines', [])

    print(f'  Groups:     {n_groups} (expected 4)')
    print(f'  Items:      {n_items} (expected 16)')
    print(f'  Machines:   {machines}')
    print()

    # Derived IDs
    print('  Derived group ids:')
    for g in puzzle['groups']:
        print(f'    tier {g["tier"]}: {g["id"]}  ({g["name"]})')
    print()

    # Image plan
    print(f'  Images ({len(image_plan)} total):')
    for src_abs, out_abs, page_rel in image_plan:
        found = os.path.isfile(src_abs)
        tag = '[OK]   ' if found else '[MISS] '
        rel_src = os.path.relpath(src_abs, REPO_ROOT)
        print(f'    {tag}{rel_src}  ->  {page_rel}')
    print()

    # Source image errors
    all_ok = True

    if source_errors:
        print(f'  Source image errors ({len(source_errors)}):')
        for e in source_errors:
            print(f'    [ERR] {e}')
        all_ok = False
        print()

    # Validation
    structural_errors, image_errors, warnings = run_validation(puzzle, puzzle_id, dry_run)

    if warnings:
        print(f'  Validation warnings:')
        for w in warnings:
            print(f'    [WARN] {w}')
    if structural_errors:
        print(f'  Validation errors ({len(structural_errors)}):')
        for e in structural_errors:
            print(f'    [ERR] {e}')
        all_ok = False
    if image_errors and dry_run:
        print(f'  Image-path notes (expected until --apply is run):')
        for e in image_errors:
            print(f'    [NOTE] {e}')
    elif image_errors and not dry_run:
        for e in image_errors:
            print(f'    [ERR] {e}')
        all_ok = False

    if structural_errors or source_errors:
        pass  # already set all_ok = False above

    # Output paths
    print()
    print('  Output paths:')
    print(f'    JSON:    {out_json_path}')
    print(f'    Images:  {out_puzzle_dir}/')
    print(f'    Index:   {out_index_path}')
    print()

    if not all_ok:
        print('[FAIL] Errors found. Fix them before running with --apply.')
        sys.exit(1)

    if dry_run:
        print('[OK]   Dry run passed. Run with --apply to write outputs.')
        return

    # ── Apply ────────────────────────────────────────────────────────────────
    os.makedirs(out_puzzle_dir, exist_ok=True)

    for src_abs, out_abs, page_rel in image_plan:
        copy_or_convert_image(src_abs, out_abs, args.max_side, args.quality)
        print(f'[WRITE] {os.path.relpath(out_abs, REPO_ROOT) if not args.out_dir else out_abs}')

    # Write puzzle JSON
    puzzle_json = json.dumps(puzzle, indent=2, ensure_ascii=False) + '\n'
    with open(out_json_path, 'w', encoding='utf-8') as f:
        f.write(puzzle_json)
    print(f'[WRITE] {os.path.relpath(out_json_path, REPO_ROOT) if not args.out_dir else out_json_path}')

    # Update index.json
    try:
        with open(out_index_path, encoding='utf-8') as f:
            registry = json.load(f)
    except (OSError, json.JSONDecodeError):
        registry = {'current': '', 'puzzles': []}

    entry = {
        'id': puzzle_id,
        'title': title,
        'date': date,
        'file': f'{puzzle_id}.json',
    }
    existing = [p for p in registry.get('puzzles', []) if p.get('id') != puzzle_id]
    existing.append(entry)
    # Sort by date descending
    existing.sort(key=lambda p: p.get('date', ''), reverse=True)
    registry['puzzles'] = existing

    if args.set_current:
        registry['current'] = puzzle_id

    index_json = json.dumps(registry, indent=2, ensure_ascii=False) + '\n'
    with open(out_index_path, 'w', encoding='utf-8') as f:
        f.write(index_json)
    print(f'[WRITE] {os.path.relpath(out_index_path, REPO_ROOT) if not args.out_dir else out_index_path}')

    if args.set_current:
        print(f'[SET]   current -> {puzzle_id}')

    # Final validation (full, with images on disk)
    final_errors, _, final_warnings = run_validation(puzzle, puzzle_id, dry_run=False)
    if args.out_dir:
        # File size check won't find the file in puzzles/; skip image path re-check
        final_errors = [e for e in final_errors if 'file not found' not in e]
    if final_errors:
        print()
        print('[WARN] Post-apply validation found issues:')
        for e in final_errors:
            print(f'  - {e}')
    else:
        print()
        print('[OK]   Post-apply validation passed.')


if __name__ == '__main__':
    main()
