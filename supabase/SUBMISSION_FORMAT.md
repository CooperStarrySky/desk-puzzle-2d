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

## The wrapper

```jsonc
{
  "format": "desk-puzzle-submission",
  "version": 2,
  "kind": "category",            // the only kind accepted since the multischool release
  "school": "cmsru",             // short code of an active school (the Studio's "Your school" list)
  "submittedAt": "2026-10-11T15:00:00.000Z",
  "credit": { "mode": "named", "name": "John D.", "line": "MS2" },   // line optional
            // or { "mode": "anonymous" }
  "contact": { "email": "john.doe@rowan.edu" },                         // or null
  "consent": true
}
```

`consent: true` covers both "I can share this" and "no identifiable patient in
any image". Credit is at most 60 characters for the name and 40 for the line.

`school` is required: 2-24 lowercase letters, digits, or hyphens, and it must
be a school whose status is `active` (the list the Studio gets from the public
`active_schools()` function). Anything else gets a plain-English 400 asking the
sender to reload the Studio and pick from the list.

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

## Full puzzles (retired)

Since the multischool release the function refuses `"kind": "puzzle"` with a
400 ("Full puzzles can't be sent any more...") before any rate counting, and the
database refuses new full-puzzle rows. Full-puzzle rows stored before then stay
as they are: the inbox can still show them and `tools/import_submission.py`
still reads their files (its full-puzzle path is kept only for those old rows).
Their stored shape was `payload = { title, groups: [4 groups with tier 1-4] }`
with images at `<uuid>/<group 1-4>-<clue-id>-info|scope.<ext>`.

## Size limit on Supabase's side

The function refuses anything over 9 MB outright and any category over 7 MB. I don't know of a documented
Supabase Edge Functions request-size limit below that, but this hasn't been
confirmed. After deploying, send one large category (around 6 MB) from the
Studio to check.

## Where it's stored

One row in `submissions`: `kind` (always `category` for new rows), `school`,
`group_name` (the category name), `suggested_tier`, and `payload`, which holds
the category with image data replaced by storage paths, plus
`submissionVersion`. Images go in the private `submissions` bucket at
`<uuid>/<clue-id>-info|scope.<ext>`.

The inbox's **Download for import** rebuilds the original file from these.
