#!/usr/bin/env python3
"""tools/externalize_images.py — extract embedded base64 images from a puzzle JSON.

Usage:
    python3 tools/externalize_images.py puzzles/<file>.json [options]

Options:
    --apply             Write WebP files and rewrite the JSON (default: dry run).
    --quality INT       WebP quality (default: 85).
    --max-side INT      Resize if the long side exceeds this value (default: 640).
                        Never upscales.

Dry run (no --apply): prints the conversion plan and estimated byte savings to
stdout without touching any file.

With --apply:
  - Creates puzzles/<puzzle-id>/ directory next to the JSON.
  - Writes each image as a WebP file:
      items[].info.image  -> puzzles/<puzzle-id>/<item-id>-info.webp
      items[].scope.image -> puzzles/<puzzle-id>/<item-id>-scope.webp
      groups[].article[].src -> puzzles/<puzzle-id>/<group-id>-article-<n>.webp
  - Rewrites the JSON field to the page-relative path puzzles/<id>/<name>.webp.
  - Writes the rewritten JSON with indent=2, ensure_ascii=False, trailing newline.
  - Every other field is preserved byte-for-byte (anki blocks survive untouched).

Consumers of .image / .src fields in game.js all accept relative paths:
  - backgroundImage: 'url("' + value + '")' works with both data URIs and paths.
  - img.src = value works with both.
  No changes to game.js runtime are needed for path-based images.
"""

import argparse
import base64
import copy
import json
import os
import sys
from io import BytesIO

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required. Install with: pip install Pillow", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def decode_data_uri(uri):
    """Return raw bytes from a data URI, or None if not a data URI."""
    if not uri or not uri.startswith("data:"):
        return None
    try:
        _, rest = uri.split(",", 1)
        return base64.b64decode(rest)
    except Exception:
        return None


def process_image(raw_bytes, max_side, quality, method=4):
    """Decode raw image bytes, optionally resize, return WebP bytes."""
    img = Image.open(BytesIO(raw_bytes))
    w, h = img.size
    long = max(w, h)
    if long > max_side:
        scale = max_side / long
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        img = img.resize((new_w, new_h), Image.LANCZOS)
    out = BytesIO()
    img.save(out, "WEBP", quality=quality, method=method)
    return out.getvalue(), img.size


def collect_images(puzzle):
    """Yield (path_keys, field_label, data_uri_value) tuples for all embedded images."""
    for item in puzzle.get("items", []):
        iid = item.get("id", "unknown")
        info_img = item.get("info", {}).get("image", "")
        if info_img and info_img.startswith("data:"):
            yield ("items", iid, "info", "image"), f"{iid}-info", info_img
        scope_img = item.get("scope", {}).get("image", "")
        if scope_img and scope_img.startswith("data:"):
            yield ("items", iid, "scope", "image"), f"{iid}-scope", scope_img

    for g in puzzle.get("groups", []):
        gid = g.get("id", "unknown")
        for idx, block in enumerate(g.get("article", [])):
            src = block.get("src", "")
            if src and src.startswith("data:"):
                yield ("groups", gid, "article", idx, "src"), f"{gid}-article-{idx}", src


def main():
    parser = argparse.ArgumentParser(
        description="Externalize base64 images from a puzzle JSON to WebP files."
    )
    parser.add_argument("puzzle_file", help="Path to the puzzle JSON file.")
    parser.add_argument("--apply", action="store_true",
                        help="Write files and rewrite JSON (default: dry run).")
    parser.add_argument("--quality", type=int, default=85,
                        help="WebP quality (default: 85).")
    parser.add_argument("--max-side", type=int, default=640,
                        help="Max long side in pixels; never upscales (default: 640).")
    args = parser.parse_args()

    puzzle_path = os.path.abspath(args.puzzle_file)
    if not os.path.isfile(puzzle_path):
        print(f"ERROR: File not found: {puzzle_path}", file=sys.stderr)
        sys.exit(1)

    with open(puzzle_path, encoding="utf-8") as f:
        original_text = f.read()
    puzzle = json.loads(original_text)

    puzzle_id = puzzle.get("id")
    if not puzzle_id:
        print("ERROR: Puzzle has no 'id' field.", file=sys.stderr)
        sys.exit(1)

    puzzle_dir = os.path.dirname(puzzle_path)
    out_dir = os.path.join(puzzle_dir, puzzle_id)
    # page-relative prefix used inside the JSON
    page_rel_prefix = f"puzzles/{puzzle_id}/"

    images = list(collect_images(puzzle))
    if not images:
        print("No embedded data-URI images found.")
        return

    print(f"Puzzle: {puzzle_id}")
    print(f"Output dir: {os.path.relpath(out_dir, REPO_ROOT)}")
    print(f"Images found: {len(images)}")
    print()

    total_old = 0
    total_new = 0
    plan = []

    for path_keys, stem, uri in images:
        raw = decode_data_uri(uri)
        if raw is None:
            print(f"  SKIP (not a data URI): {stem}")
            continue
        old_bytes = len(raw)

        webp_bytes, new_size = process_image(raw, args.max_side, args.quality)
        new_bytes = len(webp_bytes)
        filename = stem + ".webp"
        rel_path = page_rel_prefix + filename

        old_kb = old_bytes / 1024
        new_kb = new_bytes / 1024
        saving_pct = (1 - new_bytes / old_bytes) * 100 if old_bytes else 0

        print(f"  {filename}: {old_kb:.1f} KB -> {new_kb:.1f} KB ({saving_pct:.0f}% smaller), size={new_size}")
        total_old += old_bytes
        total_new += new_bytes
        plan.append((path_keys, stem, uri, filename, rel_path, webp_bytes))

    print()
    print(f"Total: {total_old/1024:.1f} KB -> {total_new/1024:.1f} KB "
          f"({(1 - total_new/total_old)*100:.0f}% reduction)")

    if not args.apply:
        print()
        print("[dry run] Pass --apply to write files and rewrite the JSON.")
        return

    # --- Apply ---
    os.makedirs(out_dir, exist_ok=True)

    # Build a deep copy of the puzzle to rewrite
    new_puzzle = copy.deepcopy(puzzle)

    for path_keys, stem, uri, filename, rel_path, webp_bytes in plan:
        # Write WebP file
        out_path = os.path.join(out_dir, filename)
        with open(out_path, "wb") as f:
            f.write(webp_bytes)
        print(f"  [WRITE] {os.path.relpath(out_path, REPO_ROOT)}")

        # Rewrite the field in the copy
        if path_keys[0] == "items":
            _, iid, section, field = path_keys
            item = next(it for it in new_puzzle["items"] if it.get("id") == iid)
            item[section][field] = rel_path
        elif path_keys[0] == "groups":
            _, gid, _, idx, field = path_keys
            grp = next(g for g in new_puzzle["groups"] if g.get("id") == gid)
            grp["article"][idx][field] = rel_path

    # Integrity check: rewritten puzzle minus image fields == original minus image fields
    def strip_images(p):
        """Return a deep copy with all image fields removed for structural comparison."""
        p2 = copy.deepcopy(p)
        for it in p2.get("items", []):
            it.get("info", {}).pop("image", None)
            it.get("scope", {}).pop("image", None)
        for g in p2.get("groups", []):
            for block in g.get("article", []):
                block.pop("src", None)
        return p2

    orig_stripped = strip_images(puzzle)
    new_stripped = strip_images(new_puzzle)
    if orig_stripped != new_stripped:
        print("ERROR: Structural integrity check failed — non-image fields differ!", file=sys.stderr)
        sys.exit(1)

    # Write rewritten JSON
    new_json = json.dumps(new_puzzle, indent=2, ensure_ascii=False) + "\n"
    with open(puzzle_path, "w", encoding="utf-8") as f:
        f.write(new_json)

    new_json_bytes = len(new_json.encode("utf-8"))
    orig_json_bytes = len(original_text.encode("utf-8"))
    print()
    print(f"[WRITE] {os.path.relpath(puzzle_path, REPO_ROOT)}")
    print(f"  JSON: {orig_json_bytes:,} bytes -> {new_json_bytes:,} bytes "
          f"({(1 - new_json_bytes/orig_json_bytes)*100:.1f}% reduction)")
    img_folder_kb = sum(
        os.path.getsize(os.path.join(out_dir, fn))
        for fn in os.listdir(out_dir)
    ) / 1024
    print(f"  Image folder: {img_folder_kb:.1f} KB")
    print()
    print("Done. Integrity check passed.")


if __name__ == "__main__":
    main()
