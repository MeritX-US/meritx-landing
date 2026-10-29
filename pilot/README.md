# MeritX private pilot (`pilot/`)

A **separate, invite-only** app for exactly one real case (1 employee, 1 partner lawyer,
1 enterprise contact, 1+ MeritX admins; total capped by `PILOT_MAX_ACCOUNTS`. This pilot uses **5**:
employee, lawyer, enterprise and 2 admins. The code default when unset is 4, so a 5-account allowlist refuses to start
unless `PILOT_MAX_ACCOUNTS=5` is set explicitly). It shares **no code, config, keys, storage or
deployment** with the public demo in `app/` and the landing site. The public demo is unchanged.

> This repository is public. Nothing private lives here: account emails, names, password
> hashes, questionnaire prompts, client names and case details are loaded only from env
> vars or untracked files (e.g. `/workspace/secrets/`, the host's secret store).

## Status (stacked PRs)

| PR | Scope | Real data allowed? |
|---|---|---|
| PR1 | allowlist login (account cap configurable via `PILOT_MAX_ACCOUNTS`; **5** for this pilot), server-side RBAC on every route, noindex, `LAWYER_APPROVED_PUBLISH` flag, separate deploy config, consent gate, access-log stub | No (plaintext storage) |
| **PR2 (stacked on PR1)** | App-level encryption at rest (AES-256-GCM, key from env) for state, files and access log; short-lived signed download URLs bound to the session; paid AI provider path (`gemini`/`openai`/`anthropic`, default `none`, inline-only, gated by `AI_PAID_TIER_VERIFIED`); `docs/AI_VENDOR_VERIFICATION.md` | Only after vendor terms verified (checklist) + lawyer-approved consent + deployment approved |
| **PR3 (stacked on PR2)** | Hash-chained access log with an off-disk anchor (stdout line per append -> Render logs; optional daily anchor email, off by default), verify against an anchor, damaged lines marked `corrupted_or_tampered`; `destroy-case` script (dry run by default, runs from compiled JS in the production image, mandatory snapshot + AI-vendor-retention confirmations); `docs/AI_VENDOR_TERMS_CHECKLIST.md` | Same as PR2 |

## Run locally (synthetic data only)

```bash
cd pilot
npm ci
npm test                       # 126 tests: config, auth, per-role RBAC, flag, noindex/CORS, encryption, signed URLs, AI, access-log chain/anchor, destroy-case, anchor email
cp .env.example .env           # fill with SYNTHETIC values
printf '%s' 'a-long-test-password' | npm run --silent hash-password   # -> scrypt$...
npm run dev                    # reads ./.env (node --env-file); http://localhost:3101
```

The server **refuses to start** unless `PRIVATE_MODE=true`, the allowlist has exactly one
employee/lawyer/enterprise and ≥1 admin within `PILOT_MAX_ACCOUNTS`, and `SESSION_SECRET` is ≥ 32 bytes.

## Roles (enforced server-side; see `src/views.ts`, `src/app.ts`)

| | employee | lawyer | enterprise | admin (MeritX ops) |
|---|---|---|---|---|
| Case status | ✅ | ✅ edit | ✅ **only this** | ✅ |
| Own questionnaire / uploads | ✅ own only (after consent) | ✅ all | ❌ | ❌ |
| Visa type | ❌ hidden | ✅ sets it | ❌ | ❌ |
| Eligibility assessment | only if `LAWYER_APPROVED_PUBLISH=true` **and** lawyer approved; shown under lawyer's name | ✅ edit/approve/revoke | ❌ | ❌ |
| Lawyer to-dos | only published ones | ✅ create/publish | ❌ | ❌ |
| Access log | ❌ | ✅ | ❌ | ✅ |
| Account list (read-only: id, name, role, enabled only; changes = env + redeploy) | ❌ | ❌ | ❌ | ✅ |
| Any employee material / questionnaire / assessment | own only | ✅ | ❌ | ❌ **never** |

Every `/api/*` route requires a session (deny by default, unknown routes 401/404), then a
per-route role gate, then role-scoped projections so a handler can't leak fields.
There is no sign-up route. Login failures are generic, rate-limited per IP+email.

## How a case flows

1. **Invited, not signed up.** There is no sign-up route. The allowlist is read from env at
   startup: exactly one employee, one lawyer, one enterprise contact, one or more MeritX admins.
   Changing it means changing env and redeploying.
2. **Employee signs consent, then fills the questionnaire and uploads.** Before consent, the
   questionnaire and upload routes refuse (412). The consent document itself lives outside this
   system — see `docs/LAUNCH_GATES.md`. File type is decided by magic bytes, never the client's
   MIME; uploads are encrypted in memory before they touch disk.
3. **Lawyer reviews.** Sees all materials, the questionnaire and each file's owner; sets the visa
   type; writes the assessment. The assessment starts **lawyer-only**.
4. **AI drafts for the lawyer only.** The lawyer picks which materials go to the vendor. The result
   is an unapproved draft (`approval: null`) that the employee cannot see. The disclosure is logged
   the moment the vendor returns, before the draft is saved.
5. **Two gates make an assessment visible to the employee**: the lawyer approves it **and**
   `LAWYER_APPROVED_PUBLISH` is on. It is then shown under the lawyer's name, labelled as the
   attorney's assessment rather than an automated determination.
6. **To-dos are published one at a time.** An unpublished to-do is absent from the employee's API
   response, not hidden by the UI.
7. **Case close.** `destroy-case` (dry run by default) plus the mandatory confirmations; destroying
   `PILOT_ENCRYPTION_KEY` crypto-shreds anything left in backups.

Throughout, the enterprise contact sees only `{role, status, updatedAt}`, and MeritX admins see
status, the access log and a four-field account list — never case substance.

## Not indexed / not public
- `GET /robots.txt` → `User-agent: * / Disallow: /`, no sitemap.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` on **every** response.
- `<meta name="robots" content="noindex...">` in the only HTML page.
- No `/uploads` static route; downloads only via `POST /api/materials/:id/download-url` → `/files/:id?exp&sig` (≤ 300 s, default 60 s, HMAC-signed, bound to the issuing session, visibility re-checked).
- Strict CORS: no wildcard; foreign-origin state-changing requests are rejected (CSRF).
- Do not link the pilot host from the landing site or sitemap.
- The public Netlify site returns a forced 404 for `/pilot` and `/pilot/*` (`netlify.toml`, tested in `test/netlify-public-site.test.ts`).

See `docs/DEPLOYMENT.md`, `docs/AUDIT_ANCHORING.md` and `docs/TODO_audit_log_and_case_destruction.md`.
`docs/LAUNCH_GATES.md` collects the things a human must decide before any real case data — what
each gate blocks, who opens it, and how.
`docs/SECURITY_REVIEW.md` records the pre-launch review of these three PRs: what was found and
fixed, and what was looked at and deliberately left as it is.

## Encryption at rest (PR2)
`src/crypto.ts`: AES-256-GCM, a fresh IV per write, and AAD bound to each record id. The key comes from
`PILOT_ENCRYPTION_KEY` (or `_FILE`). `state.enc`, every blob in `blobs/`, and every line of `access.log.enc`
are ciphertext. Uploads stay in memory and are encrypted before they are written. The store refuses to start
with a wrong key or with leftover plaintext. Destroying the key crypto-shreds all data and backups.

## AI (PR2)
`src/ai/provider.ts`. The lawyer triggers `POST /api/assessment/generate`. It needs a visa type chosen by the lawyer,
and the lawyer picks which materials are sent. Files go inline. No vendor Files API is used, and OpenAI calls set `store:false`.
Prompts come from the untracked `AI_PROMPTS_FILE`. The result is an **unapproved** draft. See `docs/AI_VENDOR_VERIFICATION.md`.

## Audit log + case close (PR3)
- Every access-log append prints `{"event":"access_log_anchor","seq":N,"entries":N+1,"hash":"..."}` to stdout.
  Render keeps it in its log store, separate from the disk, so it is the external anchor for audits. Check
  the log against it with `GET /api/access-log/verify?seq=&hash=` or `npm run verify-access-log:prod -- --seq N --hash H`.
  There is also an optional daily anchor email (`PILOT_ANCHOR_EMAIL_ENABLED`, off by default; no SMTP provider chosen yet). See `docs/AUDIT_ANCHORING.md`.
- `npm run destroy-case:prod` (production image, `node dist/src/scripts/destroy-case.js`) / `npm run destroy-case` (dev).
  Dry run by default. It reports complete only with `--ack-render-snapshots-deleted` and `--ack-ai-vendor-data <vendor>=<days|zero>`.
  See `docs/TODO_audit_log_and_case_destruction.md`.
