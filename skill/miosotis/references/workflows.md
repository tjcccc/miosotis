# miosotis worked examples

These are illustrative; IDs are placeholders. Always use the IDs the CLI returns.

## Save a thought

User: "Remember this: reports should stay frozen, and regenerating one is my call. Project roadmap."

```bash
miosotis save --request-file - --json <<'MIOSOTIS_JSON'
{"text": "Reports should stay frozen, and regenerating one is my call.", "project": "roadmap", "idempotency_key": "save-20260927-k3j9"}
MIOSOTIS_JSON
miosotis enrich prepare S-XXXX@v1 --json
miosotis enrich apply --request-file - --json <<'MIOSOTIS_JSON'
{"source_ref": {"id": "S-XXXX", "version": 1, "input_digest": "sha256:…"},
 "title": "Frozen reports and explicit regeneration", "abstract": "The user wants reports to stay frozen, with regeneration decided by the user.",
 "language": "en", "terms": ["frozen report", "regeneration", "explicit update"],
 "assertions": [{"text": "Regeneration is the user's decision", "holder": "user", "modality": "explicit"}]}
MIOSOTIS_JSON
```

Reply (in the user's language): `Saved S-XXXX@v1 · project roadmap. Enrichment complete.`

## Save a plan, then ask about it

User: "I have a meeting about the roadmap next Monday morning in the Tokyo room."

1. `miosotis save` the sentence verbatim, then `miosotis enrich prepare S-XXXX --json`. Say `received_at` is Monday 2026-09-28 and `timezone` is Asia/Shanghai.
2. `miosotis enrich apply` with a title, terms, and one event: `start {"date": "2026-10-05", "part_of_day": "morning"}`, `location` "Tokyo room", `phrase` "next Monday morning".
3. Reply: `Saved · Mon Oct 5 · morning · Tokyo room · Meeting about the roadmap`.

Later: "How many meetings do I have next week?"

1. Next week is Monday 2026-10-05 to Sunday 2026-10-11: `miosotis schedule --from 2026-10-05 --to 2026-10-11 --json`.
2. Count the meeting-like entries, and list each with its day, time or part of day, and place.

Later: "The roadmap meeting moved to Tuesday afternoon."

1. `miosotis schedule --days 14 --json` → the event `V-AAAA`.
2. Save the sentence, and enrich it with a new event `start {"date": "2026-10-06", "part_of_day": "afternoon"}` plus `"replaces": "V-AAAA"`.

## A weekly meeting

User: "Every Monday at 09:00 I attend the east region sales meeting."

1. Save the sentence verbatim, then enrich it with one event: `start {"date": "<note date>", "time": "09:00"}`, `"repeat": {"every": "week", "on": ["monday"]}`, and `phrase` "Every Monday at 09:00".
2. Reply: `Saved · every Monday · 09:00 · East region sales meeting`.

Later: "Next Monday's sales meeting is cancelled." Find the date with `miosotis schedule --days 14 --json` (event `V-SALES`, date 2026-10-05), save the sentence, and enrich it with `"cancels": [{"event": "V-SALES", "date": "2026-10-05"}]`.

## Save a pasted article

Use `"origin": "imported"`, put what is visible into `provenance`, and keep the user's own comment as a **separate** save with `"origin": "user"`. That way the article's claims are never mixed with the user's view.

## Review with coverage

User: "Show everything I noted about ingestion this month."

1. Scope: the current calendar month in the user's timezone.
2. Enumerate: `miosotis source list --since 2026-09-01 --until 2026-10-01 --json`, following `next_cursor`.
3. Search variants: `miosotis search "ingestion" --json`, `miosotis search "capture" --json`, plus the same terms in the other languages the user writes in.
4. Keep the enumerated sources that are relevant; read the unclear ones with `source get`.
5. Pin: `evidence prepare` with those `source_refs`, plus `quotes` for key sentences.
6. Write a descriptive review grouped by theme, citing `[@cN]`, and state in `limitations` which items were unenriched or unreadable.
7. `artifact create`, then reply with 2–4 lines, the `A-…` ID, and the path.

## Correct, then regenerate

User: "That note should say 'user-initiated', not 'automatic'."

1. Identify the source; ask if several match.
2. `miosotis source get S-XXXX --json` (note `current_version` and the text).
3. `miosotis source correct S-XXXX --expected-version 1 --request-file - --json` with the full corrected text.
4. Tell the user which artifacts depend on it (they keep v1 and now show a notice).
5. Enrich the new revision.
6. If they want an updated report: `evidence prepare` again (it now pins v2), then `artifact create --derived-from A-OLD` (add `--supersedes` only if replacing).

## Remove, then delete for good

User: "Remove my note about Book A."

1. Find it (`search`, `source list`); if several match, ask which.
2. `miosotis remove S-XXXX --json` (preview). Tell the user report A-YYYY cites it and stays with a notice unless they want it removed too.
3. The user: "Remove the report too." → `miosotis remove S-XXXX --with-artifacts --confirm --json`. Both are in the trash; `miosotis restore S-XXXX` would bring both back.

Later: "Empty the trash."

1. `miosotis trash empty --json` (review). Tell the user:
   - what will be deleted permanently
   - that the file saved with the note (`linked_sources_not_included`) stays
   - that backups made earlier still contain it
2. After they confirm: `miosotis trash empty --confirm --plan <plan_id> --json`.
3. Reply with what was deleted. Don't repeat the deleted content in your reply.

## Follow-up after a report

User: "Why did that change in March?"

- This is an analysis question. The existing review table does not explain causes.
- Re-read the artifact (`artifact get`) and its evidence (`evidence get`), then search for new evidence about March.
- Answer with observations and interpretations kept apart.
- Store it with `--derived-from` the review if it is worth keeping.
