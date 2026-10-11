#!/usr/bin/env python3
"""tools/import_submission.py — Turn submission files into draft specs.

Usage:
    python3 tools/import_submission.py <submission.json> [more.json ...] [--apply]

Students make a category in the Puzzle Studio (studio/?submit) and send in a
file named desk-puzzle-submission-<name>-<date>.json. This tool checks each
file and turns it into a single-group YAML spec, the same shape as the other
one-group drafts in puzzles/_spec/. A full-puzzle submission (kind "puzzle",
version 2) becomes a whole 4-group spec with the submitter's credit once, as
the top-level puzzle `credit:` ("Puzzle by ..." in the game), and an empty date for the puzzle group to fill in. Both version 1 and
version 2 files are read (format: supabase/SUBMISSION_FORMAT.md).

Dry run (default): checks every file and prints what it would write. Nothing
is written. Exits 1 if any file has a problem.

With --apply, for each good file it writes into the git-ignored submissions/
folder at the repo root:
    submissions/<slug>/<slug>.yaml   the single-group spec
    submissions/<slug>/images/       the clue images, decoded from the file
    submissions/<slug>/contact.txt   the private contact email (only if given)

The repo is public, and submissions hold answers and maybe an email, so
nothing here goes into git. The email is ONLY written to contact.txt, never
into the spec. Credit: "Credit me" becomes a `credit:` block; "Stay
anonymous" means no credit key at all.

Next step: combine four specs with tools/assemble_puzzle.py.

Options:
    --apply        Write the files.
    --force        Replace a folder that an earlier import already wrote.
    --out PATH     Write somewhere other than submissions/ (for testing).
"""

import argparse
import base64
import binascii
import datetime as dt
import json
import os
import re
import sys
from io import BytesIO

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_ROOT, 'submissions')

VALID_ZONES = ('corkboard', 'folder', 'rack', 'tubes', 'photo', 'rx')
TITLE_ZONES = ('photo', 'rack', 'tubes')
ZONE_WORDS = {'corkboard': 'sticky note', 'folder': 'paper sheet', 'rack': 'microscope slide',
              'tubes': 'X-ray film', 'photo': 'photograph', 'rx': 'prescription'}
TIER_WORDS = {1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Hardest'}
IMAGE_EXT = {'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif'}
DATA_URI_RE = re.compile(r'^data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$')
EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
SUGGESTED_RE = re.compile(r'^#\s*suggested tier:\s*([1-4])\b', re.MULTILINE)


# ── Small shared helpers (assemble_puzzle.py imports these) ──────────────────

def slugify(s):
    """Same slug rule as build_puzzle.py: lowercase ASCII letters/digits/hyphens."""
    s = str(s or '').lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return re.sub(r'-+', '-', s).strip('-')


def q(s):
    """A YAML-safe double-quoted string (JSON strings are valid YAML)."""
    return json.dumps(str(s), ensure_ascii=False)


def unique(base, used):
    """base, base-2, base-3 ... whichever is free; remembers it in `used`."""
    out, n = base, 2
    while out in used:
        out = f'{base}-{n}'
        n += 1
    used.add(out)
    return out


def group_yaml(g, tier, tier_note, image_names, sources):
    """YAML lines for one spec group.

    g: dict with name, explanation, credit (dict or None), anki (list of ints),
       article (list of blocks), items (list of dicts with id, label, zone,
       title, text). image_names[i] = (info_file or None, scope_file or None);
       sources[i] = image source text or ''.
    """
    out = [f'  - id: {g["id"]}', f'    name: {q(g["name"])}', f'    tier: {tier}   # {tier_note}',
           f'    explanation: {q(g["explanation"])}']
    credit = g.get('credit')
    if credit:
        out.append('    credit:')
        out.append(f'      name: {q(credit["name"])}')
        if credit.get('line'):
            out.append(f'      line: {q(credit["line"])}')
    if g.get('anki'):
        out.append('    anki:')
        out.extend(f'      - {int(n)}' for n in g['anki'])
    if g.get('article'):
        out.append('    article:')
        for b in g['article']:
            out.append(f'      - type: {b["type"]}')
            for k in ('text', 'src'):
                if k in b:
                    out.append(f'        {k}: {q(b[k])}')
    out.append('    items:')
    for i, it in enumerate(g['items']):
        info_file, scope_file = image_names[i]
        src_note = f'   # source: {sources[i]}' if sources[i] else ''
        out += [f'      - id: {it["id"]}', f'        label: {q(it["label"])}', f'        zone: {it["zone"]}',
                f'        title: {q(it["title"])}', f'        text: {q(it["text"])}']
        if info_file:
            out.append(f'        image: {info_file}{src_note}')
        if scope_file:
            out.append(f'        scope_image: {scope_file}{"" if info_file else src_note}')
        out.append('')
    return out


def decode_image(uri):
    """data URI -> (bytes, extension). Raises ValueError with a plain message."""
    m = DATA_URI_RE.match(uri or '')
    if not m:
        raise ValueError('is not an embedded image (expected a data:image/...;base64 value)')
    mime = m.group(1)
    if mime not in IMAGE_EXT:
        raise ValueError(f'is a {mime} image; only WebP, PNG, JPEG, and GIF are accepted')
    try:
        raw = base64.b64decode(re.sub(r'\s+', '', m.group(2)), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError('is damaged (the base64 data does not decode)')
    try:
        from PIL import Image
        with Image.open(BytesIO(raw)) as im:
            im.verify()
    except ImportError:
        pass  # Pillow missing: build_puzzle.py will catch a bad image later
    except Exception:
        raise ValueError('cannot be opened as an image')
    return raw, IMAGE_EXT[mime]

# ── Checking one submission ─────────────────────────────────────────────────

def _text(v):
    return v.strip() if isinstance(v, str) else ''


def check_submission(sub):
    """Return (problems, parsed). problems is a list of plain-English strings.

    Reads kind "category" (version 1 or 2) and kind "puzzle" (version 2); the
    format is in supabase/SUBMISSION_FORMAT.md. Mirrors the per-group and
    per-item rules of publish.py validate_puzzle (names, explanation, zones,
    labels, titles, images, Anki IDs, credit) plus the submission wrapper, with
    the same messages as supabase/functions/submit/validate.js. parsed is None
    when the file is unusable. parsed['kind'] is 'category' (one group's keys
    at the top level) or 'puzzle' (title + 'groups', a list of 4 groups)."""
    p = []
    if not isinstance(sub, dict):
        return ['the file is not a submission (expected a JSON object)'], None
    if sub.get('format') != 'desk-puzzle-submission':
        return ['the file is not a Desk Puzzle submission (format is not "desk-puzzle-submission")'], None
    version = sub.get('version')
    if version not in (1, 2) or isinstance(version, bool):
        p.append(f'version is {version!r}; this tool reads version 1 or 2')
    kind = sub.get('kind')
    if kind not in ('category', 'puzzle'):
        return p + [f'kind is {kind!r}; expected "category" or "puzzle"'], None
    if kind == 'puzzle' and version != 2:
        return p + ['whole puzzles need a version 2 file; please send it again from the Studio'], None
    v2 = version == 2 and not isinstance(version, bool)
    if sub.get('consent') is not True:
        p.append('the consent box was not ticked, so it cannot be used')
    tier = sub.get('suggestedTier')
    if kind == 'category' and (tier not in (1, 2, 3, 4) or isinstance(tier, bool)):
        p.append(f'suggested difficulty should be 1-4, got {tier!r}')
    out_credit, email = _check_credit(sub, p)
    common = {'kind': kind, 'credit': out_credit, 'email': email, 'submitted': _text(sub.get('submittedAt'))}

    if kind == 'category':
        g = sub.get('group')
        if not isinstance(g, dict):
            return p + ['the file has no category (group) in it'], None
        parsed_g = _check_group(g, '', v2, p)
        if parsed_g is None:
            return p, None
        return p, dict(parsed_g, tier=tier, **common)

    pz = sub.get('puzzle')
    if not isinstance(pz, dict):
        return p + ['the file has no puzzle in it'], None
    title = _text(pz.get('title'))
    if not title:
        p.append('the puzzle has no title')
    groups = pz.get('groups')
    if not isinstance(groups, list) or len(groups) != 4:
        return p + [f'expected 4 categories, found {len(groups) if isinstance(groups, list) else 0}'], None
    out_groups, tiers = [], []
    for gi, g in enumerate(groups, 1):
        pre = f'category {gi}: '
        if not isinstance(g, dict):
            p.append(f'category {gi} is not a category')
            continue
        gt = g.get('tier')
        if gt not in (1, 2, 3, 4) or isinstance(gt, bool):
            p.append(f'{pre}difficulty should be 1-4, got {gt!r}')
        else:
            tiers.append(gt)
        parsed_g = _check_group(g, pre, True, p)
        if parsed_g is not None:
            out_groups.append(dict(parsed_g, tier=gt))
    if len(tiers) == 4 and len(set(tiers)) != 4:
        p.append(f'each difficulty 1-4 must be used exactly once; got {", ".join(str(t) for t in tiers)}')
    if len(out_groups) != 4:
        return p, None
    return p, dict(common, title=title, groups=out_groups)


def _check_credit(sub, p):
    """Credit and contact checks. Returns (credit dict or None, email)."""
    credit = sub.get('credit')
    out_credit = None
    if not isinstance(credit, dict) or credit.get('mode') not in ('named', 'anonymous'):
        p.append('credit should say "named" or "anonymous"')
    elif credit['mode'] == 'named':
        name, line = _text(credit.get('name')), credit.get('line')
        if not name:
            p.append('asked for credit but gave no name')
        elif len(name) > 60:
            p.append(f'credit name is {len(name)} characters (max 60)')
        if line is not None and not isinstance(line, str):
            p.append('credit year/role should be text')
        elif _text(line) and len(_text(line)) > 40:
            p.append(f'credit year/role is {len(_text(line))} characters (max 40)')
        out_credit = {'name': name}
        if _text(line):
            out_credit['line'] = _text(line)

    contact = sub.get('contact')
    email = ''
    if contact is not None:
        email = _text(contact.get('email')) if isinstance(contact, dict) else ''
        if not isinstance(contact, dict) or (email and not EMAIL_RE.match(email)):
            p.append('contact email does not look like an email address')
    return out_credit, email


def _check_group(g, pre, v2, p):
    """Check one category (name, explanation, note, Anki IDs, 4 clues).

    pre is '' for a category submission and 'category N: ' inside a puzzle.
    Version 2: no separate title (it is the label); a slide's picture must be
    scope.image; only slides may have scope.image. Returns the parsed group, or
    None when the clue list is unusable."""
    name, expl = _text(g.get('name')), _text(g.get('explanation'))
    if not name:
        p.append(f'{pre}the category has no name')
    if not expl:
        p.append(f'{pre}the category has no one-line explanation')

    article = g.get('article')
    if article is not None:
        if not isinstance(article, list):
            p.append(f'{pre}the teaching note should be a list of blocks')
            article = None
        else:
            for bi, b in enumerate(article, 1):
                bt = b.get('type') if isinstance(b, dict) else None
                if bt not in ('heading', 'text', 'image'):
                    p.append(f'{pre}teaching note block {bi} has an unknown type {bt!r}')
                elif bt == 'image':
                    p.append(f'{pre}teaching note block {bi} is an image; move it to a clue or drop it')
    nids = []
    anki = g.get('anki')
    if anki is not None:
        raw = anki.get('nids') if isinstance(anki, dict) else None
        if not isinstance(raw, list):
            p.append(f'{pre}Anki note IDs should be a list')
        else:
            for n in raw:
                if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
                    p.append(f'{pre}Anki note ID {n!r} is not a positive whole number')
                else:
                    nids.append(n)

    items = g.get('items')
    if not isinstance(items, list) or len(items) != 4:
        p.append(f'{pre}expected 4 clues, found {len(items) if isinstance(items, list) else 0}')
        return None
    out_items = []
    for i, it in enumerate(items, 1):
        c = f'{pre}clue {i}'
        if not isinstance(it, dict):
            p.append(f'{c} is not a clue')
            continue
        zone = it.get('zone')
        info = it.get('info') if isinstance(it.get('info'), dict) else {}
        scope = it.get('scope') if isinstance(it.get('scope'), dict) else {}
        label = _text(it.get('label'))
        if zone not in VALID_ZONES:
            p.append(f'{c} has an unknown kind of piece {zone!r}')
        if not label:
            p.append(f'{c} has an empty label')
        if not v2 and zone in TITLE_ZONES and not _text(info.get('title')):
            p.append(f'{c} is a {ZONE_WORDS[zone]} and needs a title')
        imgs = {}
        for field, val in (('info', info.get('image')), ('scope', scope.get('image'))):
            if not val:
                continue
            if zone not in TITLE_ZONES:
                p.append(f'{c} is a {ZONE_WORDS.get(zone, "piece")} (text only) but has an image')
                continue
            if v2 and zone == 'rack' and field == 'info':
                p.append(f'{c} is a microscope slide, so its picture goes under the microscope (scope.image), not info.image')
                continue
            if v2 and zone != 'rack' and field == 'scope':
                p.append(f'{c} is a {ZONE_WORDS[zone]}; only microscope slides have a microscope image')
                continue
            try:
                imgs[field] = decode_image(val)
            except ValueError as e:
                p.append(f'{c} {"microscope image" if field == "scope" else "image"} {e}')
        if imgs and not _text(it.get('source')):
            p.append(f'{c} has an image but no source note')
        title = label if v2 else (_text(info.get('title')) or label)
        out_items.append({'label': label, 'zone': zone, 'title': title,
                          'text': info.get('text') if isinstance(info.get('text'), str) else '',
                          'images': imgs, 'source': _text(it.get('source'))})
    return {'name': name, 'explanation': expl, 'article': article or [], 'anki': nids, 'items': out_items}


# ── Writing one import ───────────────────────────────────────────────────────

def plan_import(parsed, src_name, today):
    """Return (slug, spec_text, files) where files maps relative path -> bytes."""
    date = parsed['submitted'][:10] if re.match(r'^\d{4}-\d{2}-\d{2}', parsed['submitted']) else today
    slug = f'{slugify(parsed["name"]) or "category"}-{date}'
    used, files, names, sources, items = set(), {}, [], [], []
    for it in parsed['items']:
        iid = unique(slugify(it['label']) or 'clue', used)
        info_file = scope_file = None
        if 'info' in it['images']:
            raw, ext = it['images']['info']
            info_file = f'{iid}-info.{ext}'
            files[f'images/{info_file}'] = raw
        if 'scope' in it['images']:
            raw, ext = it['images']['scope']
            scope_file = f'{iid}-scope.{ext}'
            files[f'images/{scope_file}'] = raw
        names.append((info_file, scope_file))
        sources.append(it['source'])
        items.append(dict(it, id=iid))
    g = dict(parsed, id='g-' + (slugify(parsed['name']) or 'category'), items=items)
    tier = parsed['tier']
    who = (f'named, "{parsed["credit"]["name"]}' + (f' · {parsed["credit"]["line"]}' if parsed['credit'].get('line') else '') + '"'
           if parsed['credit'] else 'anonymous (no credit key)')
    head = [
        f'# CATEGORY SUBMISSION: {parsed["name"]}',
        '#',
        f'# Imported from {src_name} on {today} by tools/import_submission.py.',
        f'# Submitted: {parsed["submitted"] or "unknown"}. Credit: {who}.',
        '# Any contact email is in contact.txt next to this file, never in this spec.',
        f'# suggested tier: {tier} ({TIER_WORDS[tier]})',
        '#',
        '# Single-group spec. Combine four with tools/assemble_puzzle.py.',
        '# Build check (flags 4/16 clues, expected for one group):',
        f'#   python3 tools/build_puzzle.py submissions/{slug}/{slug}.yaml',
        '',
        f'title: {q(parsed["name"])}',
        f'date: {date}',
    ]
    if names and any(a or b for a, b in names):
        head.append('images: images/')
    head += ['', 'groups:']
    body = group_yaml(g, tier, 'suggested by the submitter; the puzzle group decides', names, sources)
    spec_text = '\n'.join(head + body).rstrip('\n') + '\n'
    if parsed['email']:
        files['contact.txt'] = (f'Contact for "{parsed["name"]}" (private; never put this in a spec or in git)\n'
                                f'{parsed["email"]}\n').encode('utf-8')
    files[f'{slug}.yaml'] = spec_text.encode('utf-8')
    return slug, spec_text, files


def plan_puzzle_import(parsed, src_name, today):
    """Full-puzzle submission -> (slug, spec_text, files), like plan_import.

    Item ids are unique across the whole puzzle (build_puzzle.py needs that).
    The submitter's credit goes once on the whole puzzle (top-level `credit:`),
    not on each group. There is no date: the
    puzzle group picks it when publishing, and build_puzzle.py refuses an empty
    date, so the spec cannot be built by accident before that."""
    sub_date = parsed['submitted'][:10] if re.match(r'^\d{4}-\d{2}-\d{2}', parsed['submitted']) else today
    slug = f'{slugify(parsed["title"]) or "puzzle"}-submitted-{sub_date}'
    used_items, used_groups, files, body, any_image = set(), set(), {}, [], False
    for g in parsed['groups']:
        names, sources, items = [], [], []
        for it in g['items']:
            iid = unique(slugify(it['label']) or 'clue', used_items)
            info_file = scope_file = None
            if 'info' in it['images']:
                raw, ext = it['images']['info']
                info_file = f'{iid}-info.{ext}'
                files[f'images/{info_file}'] = raw
            if 'scope' in it['images']:
                raw, ext = it['images']['scope']
                scope_file = f'{iid}-scope.{ext}'
                files[f'images/{scope_file}'] = raw
            any_image = any_image or bool(info_file or scope_file)
            names.append((info_file, scope_file))
            sources.append(it['source'])
            items.append(dict(it, id=iid))
        gid = unique('g-' + (slugify(g['name']) or 'category'), used_groups)
        body += group_yaml(dict(g, id=gid, items=items, credit=None), g['tier'],
                           f'{TIER_WORDS[g["tier"]]}, set by the submitter', names, sources)
    credit = parsed['credit']
    who = (f'named, "{credit["name"]}' + (f' · {credit["line"]}' if credit.get('line') else '') + '"'
           if credit else 'anonymous (no credit key)')
    head = [
        f'# FULL PUZZLE SUBMISSION: {parsed["title"]}',
        '#',
        f'# Imported from {src_name} on {today} by tools/import_submission.py.',
        f'# Submitted: {parsed["submitted"] or "unknown"}. Credit (whole puzzle): {who}.',
        '# Any contact email is in contact.txt next to this file, never in this spec.',
        '#',
        '# Set the date before building: build_puzzle.py stops while it is empty.',
        f'#   python3 tools/build_puzzle.py submissions/{slug}/{slug}.yaml',
        '',
        f'title: {q(parsed["title"])}',
        'date: ""   # TODO: set the publish date (YYYY-MM-DD) when the puzzle group schedules it',
    ]
    if credit:  # one author for the whole puzzle: "Puzzle by ..." on the results screen
        head.append('credit:')
        head.append(f'  name: {q(credit["name"])}')
        if credit.get('line'):
            head.append(f'  line: {q(credit["line"])}')
    if any_image:
        head.append('images: images/')
    head += ['', 'groups:']
    spec_text = '\n'.join(head + body).rstrip('\n') + '\n'
    if parsed['email']:
        files['contact.txt'] = (f'Contact for "{parsed["title"]}" (private; never put this in a spec or in git)\n'
                                f'{parsed["email"]}\n').encode('utf-8')
    files[f'{slug}.yaml'] = spec_text.encode('utf-8')
    return slug, spec_text, files


def require_ignored(out_root):
    """Refuse to write answers or emails inside the public repo unless git ignores the folder."""
    if not (out_root + os.sep).startswith(REPO_ROOT + os.sep):
        return
    import subprocess
    probe = os.path.join(out_root, 'probe.txt')
    r = subprocess.run(['git', '-C', REPO_ROOT, 'check-ignore', '-q', probe], capture_output=True)
    if r.returncode != 0:
        print(f'ERROR: {os.path.relpath(out_root, REPO_ROOT)}/ is not ignored by git. Add it to .gitignore first;\n'
              '       submissions hold answers and emails and this repo is public.', file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description='Turn Desk Puzzle submissions (categories or full puzzles) into draft specs.')
    ap.add_argument('files', nargs='+', help='desk-puzzle-submission-*.json files')
    ap.add_argument('--apply', action='store_true', help='Write the specs and images (default: dry run).')
    ap.add_argument('--force', action='store_true', help='Replace folders from an earlier import.')
    ap.add_argument('--out', default=DEFAULT_OUT, help='Output folder (default: submissions/ at the repo root).')
    args = ap.parse_args()
    out_root = os.path.abspath(args.out)
    today = dt.date.today().isoformat()
    shown = os.path.relpath(out_root, REPO_ROOT) if out_root.startswith(REPO_ROOT) else out_root
    if args.apply:
        require_ignored(out_root)

    print('=== import_submission.py ===')
    print(f'  Mode:   {"APPLY" if args.apply else "DRY RUN (nothing is written; add --apply)"}')
    print(f'  Output: {shown}/')
    print()
    bad = 0
    for path in args.files:
        name = os.path.basename(path)
        print(f'- {name}')
        try:
            with open(path, encoding='utf-8') as f:
                sub = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f'    [ERR] could not read it: {e}')
            bad += 1
            continue
        problems, parsed = check_submission(sub)
        if problems:
            for msg in problems:
                print(f'    [ERR] {msg}')
            print('    Not imported. Ask the sender to fix it in the Studio, or fix the file by hand.')
            bad += 1
            continue
        puzzle = parsed['kind'] == 'puzzle'
        slug, _, files = (plan_puzzle_import if puzzle else plan_import)(parsed, name, today)
        folder = os.path.join(out_root, slug)
        credit = parsed['credit']
        if puzzle:
            print(f'    Puzzle:    {parsed["title"]} (full puzzle, 4 categories)')
            for g in sorted(parsed['groups'], key=lambda g: g['tier']):
                print(f'      tier {g["tier"]} ({TIER_WORDS[g["tier"]]}): {g["name"]}')
            print('    Date:      not set; fill in "date:" in the spec before building')
        else:
            print(f'    Category:  {parsed["name"]}')
            print(f'    Suggested: tier {parsed["tier"]} ({TIER_WORDS[parsed["tier"]]})')
        print(f'    Credit:    {credit["name"] + (" · " + credit["line"] if credit.get("line") else "") if credit else "anonymous"}')
        print(f'    Contact:   {"saved to contact.txt only" if parsed["email"] else "none given"}')
        exists = os.path.isdir(folder)
        if exists and not args.force:
            print(f'    [ERR] {shown}/{slug}/ already exists from an earlier import. Use --force to replace it.')
            bad += 1
            continue
        for rel in sorted(files):
            print(f'    {"wrote" if args.apply else "would write"} {shown}/{slug}/{rel}')
        if args.apply:
            os.makedirs(os.path.join(folder, 'images'), exist_ok=True)
            for rel, data in files.items():
                with open(os.path.join(folder, rel), 'wb') as f:
                    f.write(data)
        print()
    good = len(args.files) - bad
    print(f'Done: {good} ready, {bad} with problems.' if not args.apply else f'Done: {good} imported, {bad} skipped.')
    if good and not args.apply:
        print('Run again with --apply to write them.')
    if good and args.apply:
        print('Next: categories -> pick four and run tools/assemble_puzzle.py (see README, "Category submissions").')
        print('      full puzzles -> set the date in the spec, then run tools/build_puzzle.py on it.')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
