# MeritX private pilot (`pilot/`)

A **separate, invite-only** app for exactly one real case (1 employee, 1 partner lawyer,
1 enterprise contact, 1+ MeritX admins; total capped by `PILOT_MAX_ACCOUNTS`, default 4). It shares **no code, config, keys, storage or
deployment** with the public demo in `app/` and the landing site. The public demo is unchanged.

> This repository is public. Nothing private lives here: account emails, names, password
> hashes, questionnaire prompts, client names and case details are loaded only from env
> vars or untracked files (e.g. `/workspace/secrets/`, the host's secret store).

## Status (stacked PRs)

| PR | Scope | Real data allowed? |
|---|---|---|
| PR1 | 4-account allowlist login, server-side RBAC on every route, noindex, `LAWYER_APPROVED_PUBLISH` flag, separate deploy config, consent gate, access-log stub | No (plaintext storage) |
| **PR2 (stacked on PR1)** | App-level encryption at rest (AES-256-GCM, key from env) for state, files and access log; short-lived signed download URLs bound to the session; paid AI provider path (`gemini`/`openai`/`anthropic`, default `none`, inline-only, gated by `AI_PAID_TIER_VERIFIED`); `docs/AI_VENDOR_VERIFICATION.md` | Only after vendor terms verified (checklist) + lawyer-approved consent + deployment approved |

## Run locally (synthetic data only)

```bash
cd pilot
npm ci
npm test                       # 54 tests: config, auth, per-role RBAC, flag, noindex/CORS, encryption, signed URLs, AI
cp .env.example .env           # fill with SYNTHETIC values
printf '%s' 'a-long-test-password' | npm run --silent hash-password   # -> scrypt$...
npm run dev                    # http://localhost:3101
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
| Account list (read-only; changes = env + redeploy) | ❌ | ❌ | ❌ | ✅ |
| Any employee material / questionnaire / assessment | own only | ✅ | ❌ | ❌ **never** |

Every `/api/*` route requires a session (deny by default, unknown routes 401/404), then a
per-route role gate, then role-scoped projections so a handler can't leak fields.
There is no sign-up route. Login failures are generic, rate-limited per IP+email.

## Not indexed / not public
- `GET /robots.txt` → `User-agent: * / Disallow: /`, no sitemap.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` on **every** response.
- `<meta name="robots" content="noindex...">` in the only HTML page.
- No `/uploads` static route; downloads only via `POST /api/materials/:id/download-url` → `/files/:id?exp&sig` (≤ 300 s, default 60 s, HMAC-signed, bound to the issuing session, visibility re-checked).
- Strict CORS: no wildcard; foreign-origin state-changing requests are rejected (CSRF).
- Do not link the pilot host from the landing site or sitemap.
- The public Netlify site returns a forced 404 for `/pilot` and `/pilot/*` (`netlify.toml`, tested in `test/netlify-public-site.test.ts`).

See `docs/DEPLOYMENT.md` and `docs/TODO_audit_log_and_case_destruction.md`.

## Encryption at rest (PR2)
`src/crypto.ts`: AES-256-GCM, a fresh IV per write, and AAD bound to each record id. The key comes from
`PILOT_ENCRYPTION_KEY` (or `_FILE`). `state.enc`, every blob in `blobs/`, and every line of `access.log.enc`
are ciphertext. Uploads stay in memory and are encrypted before they are written. The store refuses to start
with a wrong key or with leftover plaintext. Destroying the key crypto-shreds all data and backups.

## AI (PR2)
`src/ai/provider.ts`. The lawyer triggers `POST /api/assessment/generate`. It needs a visa type chosen by the lawyer,
and the lawyer picks which materials are sent. Files go inline. No vendor Files API is used, and OpenAI calls set `store:false`.
Prompts come from the untracked `AI_PROMPTS_FILE`. The result is an **unapproved** draft. See `docs/AI_VENDOR_VERIFICATION.md`.
