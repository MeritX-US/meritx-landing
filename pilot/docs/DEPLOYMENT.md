# Private pilot – deployment plan (nothing has been deployed)

## Principle
A new, separate service. Do **not** reuse the public demo's Render service, Netlify site,
API keys, env vars, disk or domain. Nothing changes `app/`, `robots.txt` or `sitemap.xml` of the public site. The only public-site change is a
`netlify.toml` rule that returns 404 for `/pilot` and `/pilot/*` so pilot files are never served there.

## Steps (for the MeritX owner, after approval)
1. Approve the paid services below.
2. Create a **new** Render service from `pilot/render.pilot.yaml` (Blueprint path setting),
   `autoDeploy: false`. Or any Docker host using `pilot/Dockerfile`.
3. Set secrets in the host's secret store (never in git / chat):
   `SESSION_SECRET`, `PILOT_ACCOUNTS` (or a secret file + `PILOT_ACCOUNTS_FILE`), optional
   `PILOT_QUESTIONNAIRE_FILE`. PR2 adds `PILOT_ENCRYPTION_KEY`, `DOWNLOAD_URL_SECRET`, AI keys.
4. Use the default `*.onrender.com` name or an unlisted subdomain; never link it from the
   landing site/sitemap. Only one person holds production access.
5. Smoke test with synthetic accounts: `/robots.txt`, `X-Robots-Tag`, 401 on `/api/case`,
   each role's view. Then rotate to the 4 real accounts.
6. **No real files until PR2 is merged and deployed, AI vendor terms are verified,
   and the lawyer has approved the consent text.**

## Config the MeritX owner must fill in
| Variable | What | Where |
|---|---|---|
| `PRIVATE_MODE` | must be `true` | host env |
| `SESSION_SECRET` | `openssl rand -base64 48` | host secret store |
| `PILOT_ACCOUNTS` / `PILOT_ACCOUNTS_FILE` | 4 accounts (employee, lawyer, enterprise, admin): id, email, display name, scrypt hash from `npm run hash-password` | host secret store / `/workspace/secrets/` |
| Lawyer display `name` | shown on approved assessments | inside `PILOT_ACCOUNTS` |
| `PILOT_QUESTIONNAIRE_FILE` | optional questionnaire prompts JSON | untracked file |
| `LAWYER_APPROVED_PUBLISH` | `false` until the lawyer and the MeritX owner decide | host env |
| `PILOT_ALLOWED_ORIGINS` | leave empty (same-origin) | host env |
| `PILOT_MAX_ACCOUNTS` | **5** for this pilot (employee, lawyer, enterprise, `<admin-1>`, `<admin-2>`). Code default if unset is 4, so the 5-account allowlist fails fast unless this is set | host env |

## Paid services (none created) – estimates, Oct 2026 list prices
| Service | Needed for | Est. monthly | Source |
|---|---|---|---|
| Render web service "starter" (0.5 CPU / 512 MB) | always-on private instance (free tier sleeps and has no disk) | **$7** | render.com/pricing |
| Render persistent disk 1 GB | private data dir | **$0.25** | render.com/pricing |
| (PR2) paid AI API usage | AI processing on a paid tier | see PR2 (usage-based, est. < $20 for one case) | — |
| Optional custom domain | unlisted subdomain on existing DNS | $0 (2 included on Hobby) | render.com/pricing |
| **Total PR1** | | **≈ $7.25 / month** | |
