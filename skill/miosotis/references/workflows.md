# miosotis worked examples

These are illustrative; IDs are placeholders. Always use the IDs the CLI returns.

## Save a thought

User: "记一下：artifact 应该冻结，重新生成必须由我决定。项目 miosotis"

```bash
miosotis save --request-file - --json <<'MIOSOTIS_JSON'
{"text": "artifact 应该冻结，重新生成必须由我决定。", "project": "miosotis", "idempotency_key": "save-20260927-k3j9"}
MIOSOTIS_JSON
miosotis enrich prepare S-XXXX@v1 --json
miosotis enrich apply --request-file - --json <<'MIOSOTIS_JSON'
{"source_ref": {"id": "S-XXXX", "version": 1, "input_digest": "sha256:…"},
 "title": "Artifact 冻结与显式重新生成", "abstract": "用户认为 artifact 应冻结，重新生成须由用户决定。",
 "language": "zh", "terms": ["artifact", "冻结", "重新生成", "regeneration", "frozen report"],
 "assertions": [{"text": "重新生成必须由用户决定", "holder": "user", "modality": "explicit"}]}
MIOSOTIS_JSON
```

Reply: `已保存 S-XXXX@v1 · 项目 miosotis，已完成整理。`

## Save a pasted article

Use `"origin": "imported"`, put what is visible into `provenance`, and keep the user's own comment as a **separate** save with `"origin": "user"`. That way the article's claims are never mixed with the user's view.

## Review with coverage

User: "Show everything I noted about ingestion this month."

1. Scope: the current calendar month in the user's timezone.
2. Enumerate: `miosotis source list --since 2026-09-01 --until 2026-10-01 --json`, following `next_cursor`.
3. Search variants: `miosotis search "ingestion" --json`, `miosotis search "capture" --json`, `miosotis search "录入" --json`.
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

## Follow-up after a report

User: "Why did that change in March?"

- This is an analysis question. The existing review table does not explain causes.
- Re-read the artifact (`artifact get`) and its evidence (`evidence get`), then search for new evidence about March.
- Answer with observations and interpretations kept apart.
- Store it with `--derived-from` the review if it is worth keeping.
