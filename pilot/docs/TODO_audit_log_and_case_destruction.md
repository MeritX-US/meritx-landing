# TODO: access audit log + case-close destruction (pilot items #5, #6)

Planned to land **before or within one week after the first real upload**.

## #5 Access audit log (stub exists in `src/accessLog.ts`)
Done in PR1 (stub): append-only JSONL in the private data dir; records actor id, role,
action, resource id, outcome, timestamp; never filenames, answers, emails or AI content.
Viewable by lawyer + admin only (`GET /api/access-log`).

Remaining:
- [x] Encrypt the log at rest (PR2: each line AES-GCM).
- [x] Tamper evidence: SHA-256 hash chain (`seq`/`prev`/`hash`) + `GET /api/access-log/verify` (PR3).
- [x] Off-disk anchor (PR3): every append prints `{"event":"access_log_anchor",seq,entries,hash}` to stdout (kept in Render's log store, off the disk); `verify?seq=&hash=` / `npm run verify-access-log:prod` compare against it; optional daily anchor email (disabled by default). See `docs/AUDIT_ANCHORING.md`. Remaining: set up a Render log stream or the email before launch (Render log retention is plan-limited); the MeritX owner picks the SMTP provider.
- [x] Viewer tolerates damaged lines: they are returned as `corrupted_or_tampered` with their line number (PR3).
- [x] Log every AI vendor call (provider, model, request id, file count; no content) (PR2).
- [ ] Decide whether both admins or only the MeritX owner (<admin-1>) may read the access log (PRD: owner + lawyer).
- [ ] Export (CSV) for the lawyer's file; retention = case lifetime, destroyed with the case.
- [ ] Record IP (hashed) / user-agent for login events.

## #6 Case-close destruction
- [x] (PR3, data-dir + key-file part) `npm run destroy-case` (dry run by default; `--execute --confirm destroy-closed-case`; refuses unless case status is `closed`). In the production image: `npm run destroy-case:prod` (compiled JS; CI runs it inside the built image against a fixture). Remaining manual steps are printed by the script.
- [x] (PR3) Mandatory case-close checklist, printed by the script and recorded in its JSON report (`--report-file`). The run is reported **complete** (exit 0) only when both are confirmed; otherwise it exits 3 after deleting the data:
  - [ ] **Render disk snapshots/backups deleted** -> `--ack-render-snapshots-deleted`
  - [ ] **AI vendor retained request data deleted or expired**, with the retention period per that vendor's terms, in days or `zero` -> `--ack-ai-vendor-data <vendor>=<days>|<vendor>=zero` (repeat per vendor; `none=zero` if no AI provider was ever enabled). Take the number from `docs/AI_VENDOR_TERMS_CHECKLIST.md`.
  - The confirmations can be recorded later in a second run on the emptied data dir: `--execute --confirm destroy-closed-case --force --ack-...`.
- [ ] Full flow: lawyer export first → delete all blobs + state + access log
      from the data dir/disk → delete any remote AI vendor files (if any were created) →
      rotate/destroy `PILOT_ENCRYPTION_KEY` (crypto-shredding makes residual backups unreadable)
      → delete the Render disk/service.
- [ ] Generate a deletion certificate (what, when, by whom, vendor confirmations) for the lawyer.
- [ ] Employee-requested early deletion path.
- [ ] Deadline: within [30] days of case close (placeholder in consent draft; lawyer to confirm).
