# Starry Sky Society Puzzle

A calm pathology grouping puzzle played on a desk seen from above: sixteen
physical clues, four hidden groups, no timer, no pressure.

## The game

You look straight down at a desk. Sixteen clue pieces start as a messy pile
strewn about the desk — drag them around freely to spread out and read them,
then drag four that share something into one of the four trays along the
bottom and press its **Lock In** button. Right, and the tray locks with the
group's name (colored by difficulty tier). Wrong costs one of four mistakes;
"One away!" means three of the four belonged together. Four locked trays
wins; four mistakes loses (unless Casual mode is on).

Each item's `zone` field decides what kind of physical piece it becomes:

| `zone`      | Piece            | Readable?                                    |
| ----------- | ---------------- | -------------------------------------------- |
| `corkboard` | sticky note      | yes, on its face                             |
| `folder`    | paper sheet      | yes, on its face                             |
| `photo`     | photograph       | yes — its image (or captioned print) is the clue |
| `rx`        | prescription     | yes, on its face                             |
| `rack`      | microscope slide | no — put it on the **microscope stage** (each slide carries an anonymous letter A, B, C…) |
| `tubes`     | X-ray film       | no — slide it along the wall rail and over the **light box** |

(The retired index-card kind, `deskCards`, still loads from old files and is
shown as a paper sheet.)

**Microscope.** The stage sits on the desk; the viewer is a permanent,
static wide panel on the left of the play screen, sized to match the desk.
Slides with a `scope.image` show that image; slides
without one show their label as an etched-glass specimen, so text-only
puzzles stay solvable.

**Settings.** The gear (menu or play header) opens Settings: theme
(Light / Dark / System, persisted; the dark theme is a warm walnut room
under the same plum accent), sound, and Casual mode. Moving pieces is silent;
sound remains optional for the rest of the game feedback.

**Feedback while solving.** Wrong submissions trigger: the four pieces in the
failed tray shake sideways and the tray border flashes a danger-red tint (both
for ~400 ms); if the guess was one piece away from a correct group, the tray
border additionally pulses in the accent color for ~1200 ms. In Casual mode
(no mistake limit) the results subtitle and the share-text mistakes line both
carry a "Casual mode" tag.

**Wall lightbox.** The lightbox is fixed above the desk, with a horizontal
X-ray rail running across the wall to its left. Films slide along the rail;
the light shines through whatever part of a film physically overlaps the
glass, so partial overlap gives a partial reveal. A film's lit content is its
`info.image` if the puzzle has one, otherwise its label in glowing bone-white
lettering.

## Puzzle format

Plain JSON in `puzzles/` (see `starry-sky-society-2026-08-21.json`): 16 `items` in 4 `groups`
of 4, each item typed by its piece kind. A per-puzzle `machines` list
(e.g. `"machines": ["scope", "lightbox"]`) declares which desk machines the
puzzle uses — only those render, and validation refuses combinations that
would leave clues unreadable (slides with no microscope, films with no
light box). Older files without a `machines` field get the microscope and
wall lightbox;
legacy piece-kind ids (`corkboard`/`folder`/`rack`/`tubes`/`deskCards`) are
still read but never shown — the UI always says sticky note, paper sheet,
index card, slide, X-ray film.

Each `group` can also carry an optional `article`: an array of
`{type, ...}` blocks — `{"type":"heading","text":"..."}`,
`{"type":"text","text":"..."}`, or `{"type":"image","src":"...","caption":"..."}`
— rendered on the results screen under that group's one-line `explanation`.
It's optional and backward compatible; groups (and whole puzzle files)
without it render exactly as before.

**Image fields** (`items[].info.image`, `items[].scope.image`, `groups[].article[].src`)
accept either form:

- **Data URI** — what the editor exports directly (`data:image/jpeg;base64,...`).
  Self-contained but bloats the JSON; a puzzle with 14 embedded 640×480 images
  weighs ~850 KB.
- **Page-relative path** — a string like
  `puzzles/starry-sky-society-2026-08-21/bullous-impetigo-info.webp`.
  Produced by `tools/externalize_images.py` (see below). The game, the
  preview iframe, and all hint/results consumers accept relative paths
  without any code change.

Run `externalize_images.py` after exporting from the editor and before
`publish.py` when you want the JSON to stay small and images to be served
as separate, cache-friendly WebP files. The script is idempotent: already-
externalized fields (non-`data:` values) are skipped.

Each `group` may also carry an optional `anki` object: `{"anki": {"nids": [1499870123456, ...]}}`,
where `nids` is a list of Anki note IDs for cards that belong to that group. When any group in the
puzzle has this field, a "Copy Anki tags" button appears on the results screen; clicking it copies
an Anki Browse search string (`nid:id1,id2,...`) to the clipboard so you can open those cards
directly in Anki. Puzzles without `anki` data on any group never show the button.

## Keyboard play

Every piece is focusable:

- **1–4** sends the focused piece to that tray (first empty slot)
- **0** or **Backspace** returns it to the desk
- **V** puts a slide on the microscope, or slides a film onto the light box
- **Arrow keys** nudge a desk piece; left/right moves an X-ray along its rail

## How to run

No build step — plain HTML/CSS/JS. Serve it locally (recommended):

```
python3 -m http.server 4607 --directory "projects/Desk-Puzzle-2D"
```

then open `http://localhost:4607`. A `desk-puzzle-2d` entry for this is in
the workspace's `.claude/launch.json`. Deep link a puzzle with
`?puzzle=<id>`.

**Source layout.** All game logic lives in `src/` as browser-native ES modules — no bundler, no build step. The entry point is `src/main.js`, loaded by `index.html` as `<script type="module">`. Modules are: `engine.js` (pure rules, no DOM), `state.js` (singletons, settings, persistence), `audio.js` (WebAudio synthesis), `textures.js` (skeuomorphic texture loading), `ui-play.js` (desk/piece/drag/hints UI), `ui-menu.js` (registry, openPuzzle, nav), `editor.js` (layout panel, case editor, live preview), and `main.js` (init, event wiring). The import graph is an acyclic DAG; verify with `python3 tools/check_imports.py`. For debugging, `window.__dp2d` exposes `{ state, els, buildAnkiSearch, showResultsForPuzzle, openPuzzle }`.

**File preview (double-click `index.html` without a server).** Run
`python3 tools/publish.py --apply` first. This writes the gitignored
`puzzles/.local-puzzle-fallback.js` file that `src/main.js` uses when
`fetch()` fails under the `file://` protocol. The file is derived
automatically from the current puzzle in `puzzles/index.json`, so
it is always accurate and never hand-edited.

**Dev pages** (URL-gated, not linked from the menu): `?layout` opens Layout
Mode: collapsible sections for machines, piece sizes, scatter, and a live
Sound editor (master, per-cue gains with audition buttons, drag-scrape
thresholds), a side tab hides the whole panel, and Export bundles it all
as layout JSON.
`?editor` opens the Puzzle Creator — group-by-group authoring with piece-type
chips, machine toggles (with inline warnings when a piece kind needs a
machine you turned off), field-level validation as you type, draft
autosave, and export of both the puzzle JSON and an updated `index.json`.
Two ways to pull an existing puzzle back in to edit and re-export it:
**Load puzzle file** (any `.json` from disk) and **Load from library** (a
dropdown of everything currently in `puzzles/index.json` — pick a title and
it's fetched and loaded). Both run the file through the same structural
check the status chip uses, so a malformed or incomplete puzzle is rejected
with a toast naming the problem and the draft you were working on is left
untouched. Loading over a draft you've actually edited asks for
confirmation first; the untouched starter puzzle gets replaced silently.
Each group also has a collapsible **Article** section: an ordered list of
heading/paragraph/image blocks (reorder or remove any block, add more with
the buttons underneath) that becomes the group's full write-up on the
results screen — the one-line `explanation` field stays and becomes the
lede above it. It's optional; a group with no article renders on results
exactly as it always has.

The live preview renders the real game at a fixed size captured when the
editor opens, then scales with the drawer: full screen when the drawer is
tucked away (edge tab to show/hide, same pattern as `?layout`), shrunk to
fit beside it when open, and the drawer's left edge is a drag handle to
resize it (persisted, so it stays where you left it). Edits reach the
preview in ~150ms — typing a field, adding an article block, or flipping a
machine toggle all repaint it live, no Test Play required. A **Preview
results** button shows the results screen exactly as it'll look once
someone solves the puzzle, articles and all, without playing it out. Test
Play still opens a standalone full-size run.

### Publishing your layout

`?layout`'s Export button downloads `layout.json`. Drop that file in the
project root, next to `index.html` (same folder this README lives in), and
every player picks it up automatically on their next load — no code change,
no rebuild. Precedence, lowest to highest: the built-in defaults, then
`layout.json` if one is present, then whatever you're still live-editing in
`?layout` in your own browser (that layer lives in `localStorage` and only
applies to you, so it always wins locally until you clear it with "Reset to
defaults"). If there's no `layout.json` file, nothing changes — the fetch
for it fails silently and the built-in defaults stand.

## Drop-in assets (all optional, all auto-detected)

**Textures — `assets/textures/`.** All textures are now WebP. Drop files
with these exact names and the game uses them on the next load; anything
missing keeps the built-in CSS look. The game probes for each name via a
plain `Image` load — a missing file silently falls back to the CSS look
for that piece type:

```
desk.webp  blotter.webp  sticky.webp  sticky-pink.webp  sticky-green.webp
sticky-orange.webp  card.webp  paper.webp  slide.webp  film.webp
```

(`manifest.json` in that folder is a metadata reference only; the runtime
ignores it and probes from the hardcoded list above.)

Object textures should be alpha-transparent cutouts (the piece shadow
follows the cutout); every file is auto-trimmed to its visible pixels at
load, so margins and resolution don't matter — pieces always render at
their standard size. Numbered alternates (`sticky-2.webp`, `paper-2.webp`, …)
join the per-piece variety pool when present. Piece variety otherwise comes
from a seeded flip/hue-brightness jitter per piece (the corner-fold and tape
overlay decorations were removed in round 9 — they read as clutter, not
realism; `assets/textures/overlays/` is retired, see `CHATGPT_PROMPTS.md`).
When textures are on, clue labels render in a handwritten style over them.
`CHATGPT_PROMPTS.md` in that folder has copy-paste-ready generation
prompts (mostly retired now, kept for reference).

**Sounds — `assets/sounds/`.** Every cue is synthesized in WebAudio (no
files needed). To replace one, list it in `assets/sounds/manifest.json`
(`{"present": ["correct.mp3", …]}`) and drop the file in. Cue names:
`pickup-paper, drop-paper, pickup-glass, drop-glass, dock-glass,
film-rustle, dial-tick, pan-tick, shuffle, correct, wrong, one-away,
win, lose`.

## How to add a puzzle

1. Write `puzzles/<id>.json` by hand or export it from `?editor` (Export
   Puzzle JSON). Each group may include an optional `"anki": {"nids": [...]}`
   field — a list of Anki note IDs for that group's cards. When any group
   has this field, a "Copy Anki tags" button appears on the results screen;
   clicking it copies an Anki Browse search string to the clipboard.
2. **Optional — externalize images.** The editor embeds images as data
   URIs, which makes the JSON self-contained but large (14 images ≈ 850 KB).
   Run `python3 tools/externalize_images.py puzzles/<id>.json --apply`
   to extract each image to `puzzles/<id>/<item-id>-{info,scope}.webp`,
   rewrite the JSON to page-relative paths, and shrink the JSON to a few KB.
   Do this after exporting from the editor and before `publish.py`.
   Both data-URI and path-based image fields pass `publish.py` validation;
   `publish.py` checks that path-based images actually exist on disk.
3. Point `"current"` at the new id in `puzzles/index.json` and add its
   `{id, title, date, file}` entry — or use the editor's exported
   `index.json`.
4. Run `python3 tools/publish.py --apply` (or `--commit` to also create the
   git commit). This validates the puzzle, rewrites the five puzzle-specific
   strings in `index.html` (`<title>`, `og:title`, `twitter:title`,
   `meta description`, cache-bust `?v=`), and generates
   `puzzles/.local-puzzle-fallback.js` for file:// preview.
5. Push: `git push origin main`. Pages redeploys in about a minute.

Invalid puzzles are rejected by `publish.py` with a plain-English error
list before anything is written. Never edit `index.html` titles or the
embedded puzzle by hand — there is no embedded copy anymore.

To edit a puzzle that's already live instead of starting from scratch, open
`?editor` and use **Load from library** (pick it by title) or **Load puzzle
file** (any exported `.json`) — see the `?editor` section above — then
export again over the old file.

## Authoring a puzzle

Write a YAML spec in `puzzles/_spec/<name>.yaml`. See
`puzzles/_spec/starry-sky-society-2026-08-21.yaml` (worked example) and
`docs/ANKI_CARD_SELECTION.md` (picking AnKing note IDs). Run
`python3 tools/build_puzzle.py <spec>` (dry run), then `--apply --set-current`
to write images, the puzzle JSON, and update `index.json`. Optionally open
`?editor=1` for a test play. Finish with `python3 tools/publish.py --commit`
(validates, rewrites `index.html`, commits), then `git push origin main`.
Editor-first alternative: export JSON from `?editor`, run
`tools/externalize_images.py --apply`, then `publish.py`.

## Persistence

Progress saves to `localStorage` under `dp2d:save3:<puzzle-id>` after every
move — tray contents, locked groups, mistakes, attempt history, plus the
exact desk and wall rail: every piece's position,
rotation, and stacking order, and what's on the microscope stage. Reloading
restores the desk exactly; a finished puzzle reopens on its results. Saves
are healed on load (staging, solved groups, and machines are cross-checked),
so a stale or hand-edited save can't restore an impossible
game. Settings (Casual mode, sound, display size) live under
`dp2d:settings`; dev layout overrides under `dp2d:layout`.

## Publishing builds

The public build lives in a separate sibling repo (never the AnkiCards
workspace): `../../../Desk-Puzzle-2D-site/` → GitHub repo `desk-puzzle-2d`
(public, Pages from `main` root) → https://cooperstarrysky.github.io/desk-puzzle-2d/

To republish after changes here:

1. Copy the changed files across (everything except `.gitignore`,
   `assets/textures/originals/`, and `.DS_Store` — the site repo tracks the
   texture/sound binaries the game needs, only `originals/` stays private):
   `rsync -av --exclude .git --exclude .gitignore --exclude 'assets/textures/originals' --exclude '.DS_Store' ./ ../../../Desk-Puzzle-2D-site/`
   (keep the site README's intro line at the top if README.md changed).
2. In `Desk-Puzzle-2D-site/`: `git add -A && git commit -m "build: <what changed>" && git push`.
3. Pages redeploys automatically from `main` in about a minute.
