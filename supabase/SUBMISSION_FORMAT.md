# Submission file format (version 2)

What the Studio sends to the `submit` function (the Studio has no download;
older downloaded files use the same format). The server check is `supabase/functions/submit/validate.js`;
`tools/import_submission.py` applies the same rules with the same messages.
Version 1 category files (the older format) are still accepted unchanged.

## The request

`POST /functions/v1/submit` with JSON:

```json
{ "submission": { ... }, "turnstileToken": "", "website": "", "clientId": "3f0c...-uuid" }
```

- `website` is a honeypot: leave it empty.
- `turnstileToken` is only checked when the Turnstile secret is set.
- `clientId` (optional): a random id (uuid) the Studio keeps per browser.
  Letters, digits, and hyphens, 8-64 long; anything else is ignored.
- Hourly limits: 40 sends per internet connection (IP), and 5 per browser when
  `clientId` is present. Without `clientId` only the IP limit applies. Both are
  stored only as salted hashes.
- Reply: `{ "ok": true, "receipt": "DP-XXXX-XXXX" }` or
  `{ "ok": false, "error": "plain English", "problems": [...] }`.

## The wrapper (both kinds)

```jsonc
{
  "format": "desk-puzzle-submission",
  "version": 2,
  "kind": "category",            // or "puzzle"
  "submittedAt": "2026-10-11T15:00:00.000Z",
  "credit": { "mode": "named", "name": "John D.", "line": "MS2" },   // line optional
            // or { "mode": "anonymous" }
  "contact": { "email": "priya@rowan.edu" },                         // or null
  "consent": true
}
```

`consent: true` covers both "I can share this" and "no identifiable patient in
any image". Credit is at most 60 characters for the name and 40 for the line.
For a full puzzle the credit applies to the whole puzzle.

## A clue (version 2)

```json
{ "label": "Mesothelioma", "zone": "rack",
  "info": { "title": "Mesothelioma", "text": "Extra detail shown when a player taps the clue" },
  "scope": { "image": "data:image/webp;base64,..." },
  "source": "Wikimedia Commons, CC BY-SA 4.0",
  "note": "Asbestos exposure, decades before the tumor" }
```

- `info.title` is simply the label (the server sets it to the label anyway).
- `info.text` is optional extra detail. The game does not show it on screen
  (only screen readers hear it); the Studio no longer writes it.
- `note` (added 2026-10-11, optional) is a short plain-text line about this
  clue, shown under the clue on the results screen. 280 characters max; it
  must be text if present. It replaces the group's teaching-note line for that
  clue. Published puzzles carry it as `item.note`; specs as `note:`.
- Images are data URIs, WebP, JPEG, or PNG, at most 700 KB each once decoded.
- Which image goes where depends on the piece (`zone`), matching what the game draws:

| zone | piece | image field |
|------|-------|-------------|
| `rack` | microscope slide | `scope.image` only (an `info.image` is refused) |
| `photo` | photograph | `info.image` |
| `tubes` | X-ray film | `info.image` |
| `corkboard`, `folder`, `rx` | sticky note, paper sheet, prescription | none (text only) |

- Any clue with an image needs a non-empty `source`.
- Text caps: label 80, text 1500, source 300, note 280.

## kind "category"

```json
"suggestedTier": 2,
"group": { "name": "...", "explanation": "...", "article": [...], "anki": { "nids": [1473628085810] },
           "items": [ 4 clues ] }
```

`suggestedTier` is 1-4 (Easy, Medium, Hard, Hardest). `article` is optional
heading/text blocks (no images), 6000 characters in all. `anki.nids` is
optional, up to 50 positive whole numbers. Name 120, explanation 400. At most
8 images and a 7 MB request.

## kind "puzzle"

```jsonc
"puzzle": {
  "title": "Holes, haze, and old paint",
  "groups": [
    { "name": "...", "explanation": "...", "tier": 1, "article": [...], "anki": {...}, "items": [ 4 clues ] },
    ... exactly 4 groups
  ]
}
```

- Tiers must be exactly 1, 2, 3, and 4, each used once.
- No date: the puzzle group sets it when publishing.
- Title up to 120 characters; each group follows the category rules above.
- At most 16 images (one per clue) and a 9 MB request. The Studio compresses
  images to fit.

## Size limit on Supabase's side

The function itself refuses anything over 9 MB. I don't know of a documented
Supabase Edge Functions request-size limit below that, but this hasn't been
confirmed. After deploying, send one large full puzzle (around 8 MB) from the
Studio to check.

## Where it's stored

One row in `submissions`: `kind`, `group_name` (the category name, or the puzzle
title), `suggested_tier` (empty for puzzles), and `payload`, which holds the
category or `{ title, groups }` with image data replaced by storage paths, plus
`submissionVersion`. Images go in the private `submissions` bucket:

- category: `<uuid>/<clue-id>-info|scope.<ext>`
- puzzle: `<uuid>/<group 1-4>-<clue-id>-info|scope.<ext>`

The inbox's **Download for import** rebuilds the original file from these.
