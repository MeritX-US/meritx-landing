# TODO: access audit log + case-close destruction (pilot items #5, #6)

Planned to land **before or within one week after the first real upload**.

## #5 Access audit log (stub exists in `src/accessLog.ts`)
Done in PR1 (stub): append-only JSONL in the private data dir; records actor id, role,
action, resource id, outcome, timestamp; never filenames, answers, emails or AI content.
Viewable by lawyer + admin only (`GET /api/access-log`).

Remaining:
- [x] Encrypt the log at rest (PR2: each line AES-GCM).
- [x] Tamper evidence: SHA-256 hash chain (`seq`/`prev`/`hash`) + `GET /api/access-log/verify` (PR3). Remaining: anchor the head hash off-box (e.g. lawyer records it weekly) to detect tail truncation.
- [x] Log every AI vendor call (provider, model, request id, file count; no content) (PR2).
- [ ] Decide whether both admins or only the MeritX owner (<admin-1>) may read the access log (PRD: owner + lawyer).
- [ ] Export (CSV) for the lawyer's file; retention = case lifetime, destroyed with the case.
- [ ] Record IP (hashed) / user-agent for login events.

## #6 Case-close destruction
- [x] (PR3, data-dir + key-file part) `npm run destroy-case` (dry run by default; `--execute --confirm destroy-closed-case`; refuses unless case status is `closed`). Remaining manual steps are printed by the script.
- [ ] Full flow: lawyer export first → delete all blobs + state + access log
      from the data dir/disk → delete any remote AI vendor files (if any were created) →
      rotate/destroy `PILOT_ENCRYPTION_KEY` (crypto-shredding makes residual backups unreadable)
      → delete the Render disk/service.
- [ ] Generate a deletion certificate (what, when, by whom, vendor confirmations) for the lawyer.
- [ ] Employee-requested early deletion path.
- [ ] Deadline: within [30] days of case close (placeholder in consent draft; lawyer to confirm).
