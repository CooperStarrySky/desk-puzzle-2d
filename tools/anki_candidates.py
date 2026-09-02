#!/usr/bin/env python3
"""tools/anki_candidates.py — Find AnkiConnect candidate note IDs for a puzzle group.

Queries AnkiConnect at http://localhost:8765 (stdlib urllib only — no external deps).
For each search term, finds notes matching the model prefix and AK_Step1_v12 tag scope,
then prints a Markdown table: nid | snippet | shortest AK tag | in-house flag.

Deduplicates across terms. Never calls any mutating action.

Usage:
    python3 tools/anki_candidates.py --terms "Angelman,UBE3A,happy puppet"
        [--group g-letter-p]
        [--model "AnKingOverhaul"]
        [--limit 60]
        [--out candidates.md]

Exit codes:
    0  — success (table printed or written)
    1  — bad arguments
    2  — AnkiConnect unreachable or returned an error
"""

import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.request

ANKI_URL = "http://localhost:8765"
ANKI_VERSION = 6


# ── AnkiConnect helpers ───────────────────────────────────────────────────────

def _anki_request(action, params=None):
    """Send one AnkiConnect request and return the 'result' field.

    Raises SystemExit(2) if the connection fails or the response contains an error.
    """
    payload = json.dumps(
        {"action": action, "version": ANKI_VERSION, "params": params or {}}
    ).encode("utf-8")
    try:
        req = urllib.request.Request(ANKI_URL, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError) as exc:
        print(
            f"ERROR: Cannot reach AnkiConnect at {ANKI_URL}.\n"
            f"  Make sure Anki is running and the AnkiConnect addon is enabled.\n"
            f"  Details: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)
    except json.JSONDecodeError as exc:
        print(f"ERROR: Unexpected response from AnkiConnect: {exc}", file=sys.stderr)
        sys.exit(2)

    err = body.get("error")
    if err:
        print(f"ERROR: AnkiConnect returned an error for action '{action}': {err}",
              file=sys.stderr)
        sys.exit(2)
    return body.get("result")


def find_notes(query):
    """Return a list of note IDs matching an AnkiConnect search query."""
    return _anki_request("findNotes", {"query": query}) or []


def notes_info(nids):
    """Return note info dicts for a list of note IDs (batched in 100s)."""
    results = []
    for i in range(0, len(nids), 100):
        batch = nids[i : i + 100]
        chunk = _anki_request("notesInfo", {"notes": batch}) or []
        results.extend(chunk)
    return results


# ── Text processing ───────────────────────────────────────────────────────────

def _strip_html(text):
    """Strip HTML tags and decode entities."""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def _strip_cloze(text):
    """Replace {{cN::content}} with just the content (handles nested)."""
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r'\{\{c\d+::(.*?)\}\}', r'\1', text)
    return text


def plain_snippet(fields, max_chars=90):
    """Extract a plain-text snippet from note fields (first non-empty field)."""
    for field_data in fields.values():
        raw = field_data.get("value", "")
        if not raw.strip():
            continue
        cleaned = _strip_cloze(_strip_html(raw))
        if cleaned:
            return cleaned[:max_chars] + ("..." if len(cleaned) > max_chars else "")
    return "(no text)"


def shortest_ak_step1_tag(tags):
    """Return the shortest #AK_Step1_v12 tag, or the shortest #AK_Other::Step1 tag, or None."""
    step1 = [t for t in tags if t.startswith("#AK_Step1_v12")]
    if step1:
        return min(step1, key=len)
    other_step1 = [t for t in tags if "#Step_1" in t or "#Step1" in t]
    if other_step1:
        return min(other_step1, key=len)
    return None


def is_all_in_house(tags):
    """True if ALL tags start with #AK_ (no course/in-house tags)."""
    non_ak = [t for t in tags if t and not t.startswith("#AK_")]
    return len(non_ak) == 0


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Find AnkiConnect candidate note IDs for a puzzle group."
    )
    parser.add_argument("--group", default="", help="Group id label (for output header).")
    parser.add_argument("--terms", required=True,
                        help='Comma-separated search terms, e.g. "Angelman,UBE3A,happy puppet".')
    parser.add_argument("--model", default="AnKingOverhaul",
                        help='Note model prefix (default: AnKingOverhaul). '
                             'Query uses "note:<model>*" to match variants.')
    parser.add_argument("--limit", type=int, default=60,
                        help="Max notes per term before deduplication (default: 60).")
    parser.add_argument("--out", default=None,
                        help="Write Markdown output to this file (default: stdout).")
    args = parser.parse_args()

    terms = [t.strip() for t in args.terms.split(",") if t.strip()]
    if not terms:
        print("ERROR: --terms must contain at least one non-empty term.", file=sys.stderr)
        sys.exit(1)

    lines = []
    header = f"## Anki candidates"
    if args.group:
        header += f" — group `{args.group}`"
    lines.append(header)
    lines.append("")

    seen_nids = set()
    total_rows = 0

    for term in terms:
        # Build query: note model prefix + term text, restricted to AK_Step1_v12 tag scope
        query = f'"note:{args.model}*" {term} tag:#AK_Step1_v12*'
        nids = find_notes(query)
        if len(nids) > args.limit:
            nids = nids[: args.limit]

        new_nids = [n for n in nids if n not in seen_nids]
        seen_nids.update(new_nids)

        lines.append(f"### Term: `{term}`")
        lines.append(f"_Query:_ `{query}`  |  _{len(nids)} hit(s), {len(new_nids)} new after dedup_")
        lines.append("")

        if not new_nids:
            lines.append("_(no new results)_")
            lines.append("")
            continue

        infos = notes_info(new_nids)

        lines.append("| nid | snippet (90 chars) | shortest AK Step1 tag | all-AK? |")
        lines.append("| --- | --- | --- | --- |")

        for info in infos:
            nid = info.get("noteId", "?")
            fields = info.get("fields", {})
            tags = info.get("tags", [])

            snippet = plain_snippet(fields)
            ak_tag = shortest_ak_step1_tag(tags) or "—"
            all_ak = "yes" if is_all_in_house(tags) else "**NO**"

            # Escape pipes in snippet
            snippet_esc = snippet.replace("|", "\\|")
            ak_tag_esc = ak_tag.replace("|", "\\|")

            lines.append(f"| {nid} | {snippet_esc} | {ak_tag_esc} | {all_ak} |")
            total_rows += 1

        lines.append("")

    lines.append(f"---")
    lines.append(f"_Total unique notes: {len(seen_nids)} across {len(terms)} term(s)._")

    output = "\n".join(lines) + "\n"

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Written to {args.out} ({total_rows} rows, {len(seen_nids)} unique notes)")
    else:
        print(output)


if __name__ == "__main__":
    main()
