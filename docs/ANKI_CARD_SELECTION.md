# AnKing card selection for puzzle groups

Paste this block plus the candidate table from `anki_candidates.py` into an LLM
to pick note IDs for each group's `anki:` list.

---

## Selection rules

Pick only notes that meet all of the following:

1. **AnKing-authored.** The note must carry a canonical `#AK_Step1_v12::...` tag.
   A `#AK_Other::...::Step_1::...` tag is also acceptable. Any note that lacks
   both is out.

2. **Step 1 scope.** Do not include notes scoped only to Step 2, clerkship, or
   shelf content.

3. **No in-house tags.** If any tag on the note does not start with `#AK_`, the
   note has course or in-house content mixed in. Exclude it. The table's
   "all-AK?" column flags these as **NO**.

4. **Directly tests a clue item or the group answer.** Include a note only if it
   directly tests one of the four clue items or the unifying group diagnosis.
   Drop notes about treatment, mechanism, contrast-with-another-disease, or any
   angle already covered by a better note in the set. When two notes cover the
   same point, keep the cleaner one.

5. **3 to 6 per group, prefer 4 to 5.** Never pad. Fewer is fine when pickings are thin.

6. **No note in two groups.** Each note ID may appear at most once across the puzzle.

---

## Output contract

Return one JSON object. Keys are group IDs (strings). Values are lists of note
IDs as integers — note IDs, not card IDs. Omit groups that have zero matches
rather than including an empty list.

```json
{
  "g-letter-p": [1541799643280, 1469211959736, 1469211963576, 1469211918414],
  "g-staph-aureus": [1488680546029, 1484873092105]
}
```

---

## How to use this workflow

1. Run `anki_candidates.py` for each group in your puzzle:

   ```
   python3 tools/anki_candidates.py --group g-letter-p \
       --terms "Angelman,UBE3A,happy puppet,chromosome 15"
   ```

2. Paste the Markdown table it prints, plus the selection rules above, into the LLM.
   Ask it to apply the rules and return the JSON object.

3. Paste the returned JSON values into the spec's `anki:` lists (one flat list per
   group — `build_puzzle.py` wraps it into `{"nids": [...]}` automatically).

4. Rebuild: `python3 tools/build_puzzle.py puzzles/_spec/<name>.yaml --apply`.
