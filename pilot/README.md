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
| **PR1 (this)** | allowlist login (account cap configurable via `PILOT_MAX_ACCOUNTS`; **5** for this pilot), server-side RBAC on every route, noindex, `LAWYER_APPROVED_PUBLISH` flag, separate deploy config, consent gate, access-log stub | **No.** Files/state are stored *unencrypted* in a private data dir. |
| PR2 | App-level encryption at rest (AES-256-GCM, key from env), short-lived signed download URLs, paid AI provider path (configurable), vendor-terms verification doc | Only after PR2 + vendor terms verified + lawyer-approved consent |

## Run locally (synthetic data only)

```bash
cd pilot
npm ci
npm test                       # 58 tests: config, auth, per-role RBAC, flag, noindex/CORS
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
| Account list (read-only: id, name, role, enabled only; changes = env + redeploy) | ❌ | ❌ | ❌ | ✅ |
| Any employee material / questionnaire / assessment | own only | ✅ | ❌ | ❌ **never** |

Every `/api/*` route requires a session (deny by default, unknown routes 401/404), then a
per-route role gate, then role-scoped projections so a handler can't leak fields.
There is no sign-up route. Login failures are generic, rate-limited per IP+email.

## Not indexed / not public
- `GET /robots.txt` → `User-agent: * / Disallow: /`, no sitemap.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` on **every** response.
- `<meta name="robots" content="noindex...">` in the only HTML page.
- No `/uploads` static route; downloads require a session (PR2: signed URLs).
- Strict CORS: no wildcard; foreign-origin state-changing requests are rejected (CSRF).
- Do not link the pilot host from the landing site or sitemap.
- The public Netlify site returns a forced 404 for `/pilot` and `/pilot/*` (`netlify.toml`, tested in `test/netlify-public-site.test.ts`).

See `docs/DEPLOYMENT.md` and `docs/TODO_audit_log_and_case_destruction.md`.
