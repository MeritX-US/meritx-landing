# Private pilot – deployment plan (nothing has been deployed)

## Principle
A new, separate service. Do **not** reuse the public demo's Render service, Netlify site,
API keys, env vars, disk or domain. The public site's `/pilot` and `/pilot/*` routes return
404. Landing uses `/workspace/` to hand invited users to the separate service's login page.

## Steps (for the MeritX owner, after approval)
1. Approve the paid services below.
2. Create a **new** Render service from `pilot/render.pilot.yaml` (Blueprint path setting),
   `autoDeploy: false`. Or any Docker host using `pilot/Dockerfile`.
3. Set secrets in the host's secret store (never in git / chat):
   `SESSION_SECRET`, `PILOT_ACCOUNTS` (or a secret file + `PILOT_ACCOUNTS_FILE`), optional
   `PILOT_QUESTIONNAIRE_FILE`, `PILOT_ENCRYPTION_KEY` (back it up offline in a password manager:
   losing it means the data is unrecoverable), `DOWNLOAD_URL_SECRET`, and later `AI_*`.
4. Verify login on the host-provided HTTPS address or attach `workspace.meritx.us`. Once
   the service is ready for invited users, enable the public Workspace sign-in handoff below.
5. Smoke test with synthetic accounts: `/robots.txt`, `X-Robots-Tag`, 401 on `/api/case`,
   each role's view. Then rotate to the 5 real accounts.
6. **No real files until PR2 is merged and deployed, AI vendor terms are verified,
   and the lawyer has approved the consent text.** See `docs/LAUNCH_GATES.md` for all of them.

## Enterprise trial setup

Provision a separate instance for one enterprise and its partner firm. On a new Render
disk mounted at `/data`, set `PILOT_DATA_DIR=/data/original` and
`PILOT_DRAFT_REGISTER_DIR=/data/enterprise-register` so both stores persist in separate
directories. Set `PILOT_DRAFT_REGISTER_KEY` to a separate 32-byte base64 key and back it up
alongside the original case key. For an existing service, retain the original data directory
until any storage migration has been planned and verified.

Allowlist the HR contact, lawyer, employees and admin. Set `PILOT_MAX_ACCOUNTS` to cover
the total and set `PILOT_PRIMARY_EMPLOYEE_ID` for a multi-employee instance. Run the
[enterprise trial walkthrough](../README.md#enterprise-trial) with fictional cases. Establish
the trial's retention and individual case closeout procedure before accepting actual
documents. Set the lawyer-approved consent file and version as described in the launch gates.

### Free synthetic trial

Use the separate Render Blueprint at `pilot/render.demo.yaml`. It creates one free web
service and generates `PILOT_DEMO_PASSWORD` in its environment. Retrieve the password from
that service's Environment page and share it privately with the invited testers. The demo
accounts are `enterprise@preview.example.test`, `lawyer@preview.example.test`,
`employee@preview.example.test`, and `employee2@preview.example.test`.

The demo restores two fictional cases at process startup. Requests and uploads added during
a session are temporary. AI and phone vendors are disabled. Verify the hosted login before
enabling the Landing handoff.

## Landing sign-in handoff

After the workspace DNS, HTTPS and login checks pass, set `MERITX_WORKSPACE_URL` on
Netlify to the workspace origin, for example `https://workspace.meritx.us/`, and rebuild
Landing. The build generates an exact redirect for `/workspace/`. Verify in a private
browser window that **Workspace sign in** opens the invitation-only login. If the setting
is absent, that route displays the invitation instructions and a trial-request link.
Leave the workspace origin out of the public sitemap.

## Config the MeritX owner must fill in
| Variable | What | Where |
|---|---|---|
| `PRIVATE_MODE` | must be `true` | host env |
| `SESSION_SECRET` | `openssl rand -base64 48` | host secret store |
| `PILOT_ACCOUNTS` / `PILOT_ACCOUNTS_FILE` | the 5 accounts for this pilot (employee, lawyer, enterprise, `<admin-1>`, `<admin-2>`): id, email, display name, scrypt hash from `npm run hash-password`. Must stay within `PILOT_MAX_ACCOUNTS` (see below) or the server refuses to start | host secret store / `/workspace/secrets/` |
| Lawyer display `name` | shown on approved assessments | inside `PILOT_ACCOUNTS` |
| `PILOT_QUESTIONNAIRE_FILE` | optional questionnaire prompts JSON | untracked file |
| `LAWYER_APPROVED_PUBLISH` | `false` until the lawyer and the MeritX owner decide | host env |
| `PILOT_ALLOWED_ORIGINS` | leave empty (same-origin) | host env |
| `PILOT_ENCRYPTION_KEY` | `openssl rand -base64 32`; keep an offline backup | host secret store |
| `DOWNLOAD_URL_SECRET` | `openssl rand -base64 48`, ≠ SESSION_SECRET | host secret store |
| `DOWNLOAD_URL_TTL_SECONDS` | default 60 (max 300) | host env |
| `AI_PROVIDER`, `AI_MODEL` | choose after vendor verification; keep `none` until then | host env |
| `AI_API_KEY` | new key from a **paid** project dedicated to the pilot | host secret store |
| `AI_PAID_TIER_VERIFIED` | `true` only after `docs/AI_VENDOR_VERIFICATION.md` is done | host env |
| `AI_PROMPTS_FILE` | untracked prompt templates (Render Secret File) | host secret file |
| `PILOT_ACCESS_LOG_ANCHOR_STDOUT` | keep `true`: anchor line per access-log append goes to Render logs (off-disk). Consider a Render log stream for retention beyond the plan's log window | host env |
| `PILOT_ANCHOR_EMAIL_ENABLED`, `SMTP_*` | optional daily anchor email, `false` until the MeritX owner picks an SMTP provider; see `docs/AUDIT_ANCHORING.md` | host env / secret store |
| `PILOT_MAX_ACCOUNTS` | **5** for this pilot (employee, lawyer, enterprise, `<admin-1>`, `<admin-2>`). Code default if unset is 4, so the 5-account allowlist fails fast unless this is set | host env |

## Paid services (none created) – estimates, Oct 2026 list prices
| Service | Needed for | Est. monthly | Source |
|---|---|---|---|
| Render web service "starter" (0.5 CPU / 512 MB) | always-on private instance (free tier sleeps and has no disk) | **$7** | render.com/pricing |
| Render persistent disk 1 GB | private data dir | **$0.25** | render.com/pricing |
| Paid AI API (one of Gemini paid tier / OpenAI / Anthropic) | AI drafts on a no-training paid tier | **≈ $7–15 per case, budget ≤ $20/mo** (usage-based; may need $5+ prepaid credit) | vendor pricing pages, see AI_VENDOR_VERIFICATION.md |
| Optional ZDR / enterprise agreement | zero data retention | unknown; via vendor sales, may have minimums | — |
| Optional custom domain | unlisted subdomain on existing DNS | $0 (2 included on Hobby) | render.com/pricing |
| **Total** | | **≈ $7.25 / month hosting + ≤ $20 / month AI** | |
