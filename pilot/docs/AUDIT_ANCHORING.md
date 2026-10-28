# Access-log anchoring (tamper evidence outside the data disk)

The access log (`access.log.enc` on the Render persistent disk) is a SHA-256 hash chain: every entry
carries `seq`, `prev` and `hash`. On its own, the chain catches edited, deleted, inserted or
reordered lines. It **cannot** catch someone who cuts entries off the end, or who rewrites the
whole file as a new valid chain. To catch those, compare the log against a head hash (an "anchor")
stored somewhere the disk's owner can't edit.

## Anchor copy 1: stdout -> Render logs (always on)
After every append the server prints one structured line to stdout:

```json
{"event":"access_log_anchor","seq":41,"entries":42,"hash":"<64 hex>"}
```

- It contains only `seq` (0-based seq of the newest entry), `entries` (count) and `hash`. No account ids,
  emails, names, actions, resources or case data.
- Render captures stdout and keeps it in its log store, **which is separate from the service's disk**.
  Wiping or rewriting the disk doesn't change those log lines, so they are the external anchor for
  audits.
- Render keeps dashboard logs only for a limited, plan-dependent time (7 days on Hobby, 14 on Pro,
  30 on Scale/Enterprise per render.com/docs/logging as of Oct 2026; check again before launch). For a
  longer record, set up a Render **log stream** to an external log provider, or turn on the daily email
  below, or have the lawyer write down an anchor on a schedule.
- Turn it off only for local tests: `PILOT_ACCESS_LOG_ANCHOR_STDOUT=false` (default `true`).

## Anchor copy 2: optional daily email (disabled by default)
`PILOT_ANCHOR_EMAIL_ENABLED=true` sends the current `{seq, entries, hash}` to the lawyer at most once
per UTC day (`src/anchorEmail.ts`; the last sent day is kept in `anchor-email.state.json` in the data
dir, so a restart doesn't send twice). The stdout line stays on as the second copy.

| Variable | Meaning |
|---|---|
| `PILOT_ANCHOR_EMAIL_ENABLED` | `false` (default) / `true` |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server (port default 587) |
| `SMTP_SECURE` | implicit TLS; default `true` only for port 465. Otherwise STARTTLS is **required** |
| `SMTP_USER`, `SMTP_PASSWORD` (or `SMTP_PASSWORD_FILE`) | set both or neither; host secret store only |
| `SMTP_FROM` | sender address |
| `SMTP_TO` | recipient; defaults to the lawyer account's email |
| `SMTP_REQUIRE_TLS` | local testing only; `false` is refused when `NODE_ENV=production` |

**No SMTP provider is chosen in this repo and no credentials are committed.** The MeritX owner
(`<admin-1>`) picks the provider and sets these values in the host's secret store before launch.
The email holds only date, seq, count and hash. Failures are logged as
`{"event":"access_log_anchor_email","ok":false}` with no host/user details, and are retried every 15 minutes.

## Checking the log against an anchor
- API (lawyer/admin): `GET /api/access-log/verify?seq=41&hash=<64 hex>` returns
  `{ ok, entries, head, anchor: { seq, hash, match, reason? } }`. `ok` is true only when the chain is
  intact **and** the entry at `seq` has exactly that hash.
- CLI, read-only, on the host / in the production image:
  `npm run verify-access-log:prod -- --seq 41 --hash <64 hex>` or
  `npm run verify-access-log:prod -- --anchor '<the JSON line copied from the Render logs>'`
  (dev: `npm run verify-access-log -- --data-dir ./data ...`). Exit 0 = ok, 1 = broken or
  mismatch, 2 = bad input. Needs `PILOT_ENCRYPTION_KEY` (or `_FILE`).
- Audit routine: take the **latest** anchor line from Render's logs (or the latest email) and check it.
  If the log is shorter than the anchor says, or the hash differs, the log was truncated or rewritten.

## Damaged lines in the viewer
`GET /api/access-log` never fails because of one bad line. A line that can't be decrypted or parsed,
or whose own hash or link to the line before it doesn't check out, comes back as
`{ "line": <1-based line number>, "corrupted_or_tampered": true, "reason": "..." }`, and every other
entry comes back as normal (each with its `line`). The UI shows such rows as
`line N: CORRUPTED OR TAMPERED (reason)`.
