#!/usr/bin/env python3
"""tools/assemble_puzzle.py — Combine four single-group specs into one puzzle spec.

Usage:
    python3 tools/assemble_puzzle.py --title "Fruit, Lead, and Stars" --date 2026-10-17 \\
        a.yaml b.yaml c.yaml d.yaml [--tiers 1,2,3,4] [--apply]

Each input is a single-group spec, usually one written by
tools/import_submission.py (submissions/<slug>/<slug>.yaml). The tool:
  - gives each group its own difficulty tier: from --tiers (in the same order
    as the files), or else from each file's "# suggested tier: N" comment,
    moving groups to the nearest free tier when two want the same one;
  - renames clue ids (and group ids) that clash across groups, and warns when
    two pieces carry the same label;
  - keeps each group's credit, teaching note, Anki IDs, and image sources;
  - copies every clue image into one <puzzle-id>-src/ folder.

Dry run (default): prints the plan and every change. Nothing is written.
With --apply it writes, inside the git-ignored submissions/ folder:
    submissions/assembled/_spec/<puzzle-id>.yaml
    submissions/assembled/<puzzle-id>-src/        (the images)
That mirrors puzzles/_spec/ and puzzles/<id>-src/, so after reviewing it you
can move the spec into puzzles/_spec/ and the -src folder into puzzles/ as-is,
then run tools/build_puzzle.py on it as usual.

Options:
    --force      Replace an earlier assembled spec and -src folder.
    --out PATH   Write somewhere other than submissions/assembled/ (for testing).
"""

import argparse
import os
import re
import shutil
import sys

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_submission import (REPO_ROOT, SUGGESTED_RE, TIER_WORDS, group_yaml, q,  # noqa: E402
                               require_ignored, slugify, unique)

DEFAULT_OUT = os.path.join(REPO_ROOT, 'submissions', 'assembled')
SOURCE_RE = re.compile(r'^\s*(?:scope_)?image:\s*(\S+)\s*#\s*source:\s*(.+?)\s*$', re.MULTILINE)


def puzzle_id(title, date):
    """Same rule as build_puzzle.py: slug(title minus a trailing "Puzzle") + "-" + date."""
    return slugify(re.sub(r'\s+puzzle\s*$', '', title, flags=re.IGNORECASE).strip()) + '-' + date


def load_one(path, errors):
    """Read a single-group spec. Returns a dict or None (and adds to errors)."""
    try:
        with open(path, encoding='utf-8') as f:
            raw = f.read()
        spec = yaml.safe_load(raw)
    except (OSError, yaml.YAMLError) as e:
        errors.append(f'{path}: could not read it ({e})')
        return None
    groups = spec.get('groups') if isinstance(spec, dict) else None
    if not isinstance(groups, list) or len(groups) != 1:
        errors.append(f'{path}: expected exactly 1 group, found {len(groups) if isinstance(groups, list) else 0}')
        return None
    g = groups[0]
    m = SUGGESTED_RE.search(raw)
    suggested = int(m.group(1)) if m else (g.get('tier') if g.get('tier') in (1, 2, 3, 4) else None)
    spec_dir = os.path.dirname(os.path.abspath(path))
    img_dir = os.path.normpath(os.path.join(spec_dir, spec.get('images') or ''))
    return {'path': path, 'group': g, 'suggested': suggested, 'img_dir': img_dir,
            'sources': dict(SOURCE_RE.findall(raw))}


def pick_tiers(entries, forced, report):
    """Assign tiers 1-4, one per group. Returns a list parallel to entries."""
    if forced:
        for e, t in zip(entries, forced):
            note = f'set by --tiers (suggested {e["suggested"] or "none"})'
            e['tier_note'] = note
        return list(forced)
    free, out = {1, 2, 3, 4}, [None] * len(entries)
    order = sorted(range(len(entries)), key=lambda i: (entries[i]['suggested'] or 9, i))
    for i in order:
        want = entries[i]['suggested']
        name = entries[i]['group'].get('name', '?')
        if want in free:
            got = want
            entries[i]['tier_note'] = f'suggested {want}'
        else:
            # nearest free tier; on a tie, the harder one
            got = min(free, key=lambda t: (abs(t - (want or 2.5)), -t))
            entries[i]['tier_note'] = f'suggested {want or "none"}, moved to {got}'
            report.append(f'tier clash: "{name}" suggested {want or "nothing"}; '
                          f'gave it tier {got} ({TIER_WORDS[got]}) instead')
        free.discard(got)
        out[i] = got
    return out


def main():
    ap = argparse.ArgumentParser(description='Combine four single-group specs into one puzzle spec.')
    ap.add_argument('specs', nargs='+', help='four single-group .yaml specs')
    ap.add_argument('--title', required=True, help='puzzle title')
    ap.add_argument('--date', required=True, help='release date, YYYY-MM-DD')
    ap.add_argument('--tiers', help='tiers for the files in order, e.g. 2,1,4,3 (default: use suggestions)')
    ap.add_argument('--apply', action='store_true', help='write the spec and images (default: dry run)')
    ap.add_argument('--force', action='store_true', help='replace an earlier assembled spec')
    ap.add_argument('--out', default=DEFAULT_OUT, help='output folder (default: submissions/assembled/)')
    args = ap.parse_args()

    errors, report = [], []
    if len(args.specs) != 4:
        errors.append(f'give exactly 4 specs (got {len(args.specs)})')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', args.date):
        errors.append(f'--date should look like 2026-10-17 (got {args.date!r})')
    forced = None
    if args.tiers:
        try:
            forced = [int(x) for x in args.tiers.split(',')]
        except ValueError:
            forced = []
        if sorted(forced) != [1, 2, 3, 4]:
            errors.append(f'--tiers must use 1, 2, 3, and 4 once each (got {args.tiers!r})')
    entries = [e for e in (load_one(p, errors) for p in args.specs) if e]
    if errors:
        print('=== assemble_puzzle.py ===')
        for e in errors:
            print(f'  [ERR] {e}')
        sys.exit(1)

    pid = puzzle_id(args.title, args.date)
    out_root = os.path.abspath(args.out)
    shown = os.path.relpath(out_root, REPO_ROOT) if out_root.startswith(REPO_ROOT) else out_root
    spec_rel, src_rel = f'_spec/{pid}.yaml', f'{pid}-src'
    tiers = pick_tiers(entries, forced, report)

    used_items, used_groups, used_files, labels = set(), set(), set(), {}
    copies, groups = [], []
    for e, tier in sorted(zip(entries, tiers), key=lambda x: x[1]):
        g = e['group']
        name = str(g.get('name') or '').strip()
        gid0 = g.get('id') or 'g-' + slugify(name)
        gid = unique(gid0, used_groups)
        if gid != gid0:
            report.append(f'group id clash: "{name}" is now {gid}')
        credit = g.get('credit')
        if isinstance(credit, str):
            credit = {'name': credit.strip()}
        anki = g.get('anki')
        anki = anki.get('nids', []) if isinstance(anki, dict) else (anki or [])
        items, names, sources = [], [], []
        for it in g.get('items') or []:
            label = str(it.get('label') or '').strip()
            iid0 = it.get('id') or slugify(label) or 'clue'
            iid = unique(iid0, used_items)
            if iid != iid0:
                report.append(f'clue id clash: "{label}" in "{name}" is now {iid}')
            key = label.lower()
            if key in labels:
                report.append(f'same label twice: "{label}" is in "{labels[key]}" and "{name}"; '
                              'players cannot tell those pieces apart, so reword one')
            labels.setdefault(key, name)
            pair, src_note = [], ''
            for field in ('image', 'scope_image'):
                fn = it.get(field)
                if not fn:
                    pair.append(None)
                    continue
                src_abs = os.path.join(e['img_dir'], fn)
                if not os.path.isfile(src_abs):
                    errors.append(f'"{label}" in "{name}": image not found: {os.path.relpath(src_abs, REPO_ROOT)}')
                base, ext = os.path.splitext(os.path.basename(fn))
                new = unique(base, used_files) + ext
                if new != base + ext:
                    report.append(f'image name clash: {fn} from "{name}" is copied as {new}')
                copies.append((src_abs, new))
                pair.append(new)
                src_note = src_note or e['sources'].get(fn, '')
            names.append(tuple(pair))
            sources.append(src_note)
            items.append({'id': iid, 'label': label, 'zone': it.get('zone', ''),
                          'title': str(it.get('title') or label), 'text': str(it.get('text') or '')})
        groups.append(({'id': gid, 'name': name, 'explanation': str(g.get('explanation') or '').strip(),
                        'credit': credit, 'anki': anki, 'article': g.get('article') or [], 'items': items},
                       tier, e['tier_note'], names, sources, e['path']))

    print('=== assemble_puzzle.py ===')
    print(f'  Mode:      {"APPLY" if args.apply else "DRY RUN (nothing is written; add --apply)"}')
    print(f'  Puzzle id: {pid}')
    print(f'  Title:     {args.title}')
    print(f'  Date:      {args.date}')
    print()
    for g, tier, note, _, _, path in groups:
        c = g['credit']
        by = (c.get('name', '') + (' · ' + c['line'] if c.get('line') else '')) if isinstance(c, dict) else 'anonymous'
        print(f'  Tier {tier} ({TIER_WORDS[tier]}): {g["name"]}  [{note}; credit: {by}]')
        print(f'      from {os.path.relpath(os.path.abspath(path), REPO_ROOT)}')
    print()
    print(f'  Changes ({len(report)}):' if report else '  Changes: none (no clashes)')
    for r in report:
        print(f'    - {r}')
    if errors:
        print()
        for e in errors:
            print(f'  [ERR] {e}')
        sys.exit(1)

    head = [f'# {args.title}: assembled from {len(groups)} category submissions by tools/assemble_puzzle.py.',
            '# Review everything (wording, images, sources, tiers) before moving this file into',
            f'# puzzles/_spec/ and {src_rel}/ into puzzles/, then run:',
            f'#   python3 tools/build_puzzle.py puzzles/_spec/{pid}.yaml',
            '#', '# Sources:']
    head += [f'#   tier {t}: {os.path.basename(p)}' for _, t, _, _, _, p in groups]
    if report:
        head += ['#', '# Changes made while assembling:'] + [f'#   - {r}' for r in report]
    head += ['', f'title: {q(args.title)}', f'date: {args.date}', f'images: ../{src_rel}/', '', 'groups:']
    body = []
    for g, tier, note, names, sources, _ in groups:
        body += group_yaml(g, tier, note, names, sources)
    text = '\n'.join(head + body).rstrip('\n') + '\n'

    spec_abs, src_abs_dir = os.path.join(out_root, spec_rel), os.path.join(out_root, src_rel)
    print()
    exists = os.path.exists(spec_abs) or os.path.exists(src_abs_dir)
    if exists and not args.force:
        print(f'  [ERR] {shown}/{spec_rel} or {shown}/{src_rel}/ already exists. Use --force to replace them.')
        sys.exit(1)
    verb = 'wrote' if args.apply else 'would write'
    print(f'  {verb} {shown}/{spec_rel}')
    print(f'  {verb} {shown}/{src_rel}/ ({len(copies)} image{"s" if len(copies) != 1 else ""})')
    if not args.apply:
        print('\nDry run only. Run again with --apply to write them.')
        return
    require_ignored(out_root)
    if os.path.isdir(src_abs_dir):
        shutil.rmtree(src_abs_dir)
    os.makedirs(src_abs_dir)
    os.makedirs(os.path.dirname(spec_abs), exist_ok=True)
    for src, new in copies:
        shutil.copyfile(src, os.path.join(src_abs_dir, new))
    with open(spec_abs, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f'\nNext: check it with  python3 tools/build_puzzle.py {shown}/{spec_rel}')


if __name__ == '__main__':
    main()
