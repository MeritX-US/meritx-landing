# Launch gates — what a human must do before any real case data

The code is written and tested. It is also deliberately in a state that refuses to touch a real
case. Nothing below is unfinished work: each gate exists because the answer it waits for is not
something software can check — whether a lawyer approved a document, what a vendor's contract
actually says, whether the owner agreed to pay for the hosting.

Opening a gate is an act by a named person. That is the point: afterwards the record shows who
opened it and when, rather than "the system just started doing this".

| # | Gate | Who decides | How it is enforced | State today |
|---|---|---|---|---|
| 1 | AI vendor terms verified | whoever reads the contract | **hard** — the server refuses to start | not opened (`AI_PROVIDER=none`) |
| 2 | Lawyer-approved consent text | the partner lawyer | soft — every signature is stamped `draft-lawyer-review-required` | not opened |
| 3 | Deployment approved | the MeritX owner | semi-hard — `autoDeploy: false`, blueprint not at repo root | not opened (nothing deployed) |
| 4 | Anchor retention chosen | MeritX ops | none — documented decision | not chosen |
| 5 | `SESSION_TTL_SECONDS` / `MAX_UPLOAD_BYTES` chosen | MeritX ops | none — defaults apply (8 h / 25 MB) | not chosen |
| 6 | `LAWYER_APPROVED_PUBLISH` | lawyer + MeritX owner | runtime flag, default `false` | `false` |

## Gate 1 — AI vendor terms (hard)

`src/config.ts`, in `loadAiConfig`:

```ts
// Human gate: someone must have completed docs/AI_VENDOR_VERIFICATION.md for this account.
if (env.AI_PAID_TIER_VERIFIED !== 'true') {
  throw new ConfigError('AI_PAID_TIER_VERIFIED=true is required to enable an AI provider …');
}
```

Set `AI_PROVIDER` to a real vendor without `AI_PAID_TIER_VERIFIED=true` and the process exits at
startup. There is no degraded mode and no warning-and-continue.

Case material sent to a vendor cannot be recalled, so the gate sits before the first request, not
after it. To open it: complete `docs/AI_VENDOR_VERIFICATION.md` for the specific account and paid
tier that will be used — retention period, training use, deletion on request — and record the
numbers in `docs/AI_VENDOR_TERMS_CHECKLIST.md`. Those numbers are needed again at case close, for
`destroy-case --ack-ai-vendor-data <vendor>=<days|zero>`.

## Gate 2 — Consent text (soft, but it leaves a mark)

**The consent document itself is not in this system.** The repository is public, and the document is
the law firm's professional work product. What the employee sees is a pointer to it
(`public/app.js`):

> Please read the privacy and AI processing consent provided by your attorney before continuing.
> \[ I have read and agree \]

The system records only who agreed, when, and to *which version*:

```json
"consent": { "accountId": "u-emp", "signedAt": "…", "version": "draft-lawyer-review-required" }
```

So `CONSENT_VERSION` (`src/app.ts`) is a label naming an external document, not draft text awaiting
edits. Its current value says, on every signature it stamps, that the document had not been through
the lawyer.

This gate does not block anything. An employee can sign today and the questionnaire and uploads
will open up. What it guarantees is that the record cannot later be mistaken for informed consent
to an approved document.

### Opening it

1. **The lawyer finalises the document** (outside this system): what is collected, how it is stored,
   which AI vendors receive it and on what terms, how long until destruction. It carries the firm's
   name, not MeritX's.
2. **Change the label** in `pilot/src/app.ts`:
   ```diff
   - export const CONSENT_VERSION = 'draft-lawyer-review-required';
   + export const CONSENT_VERSION = '2026-11-03-privacy-ai-consent-v1';
   ```
   Any string will do as long as it identifies that exact document and version unambiguously —
   date + name + version is the usual shape.
3. **PR, merge, deploy.** From then on each signature carries the new label.
4. **Deliver the document to the employee** through the firm's own channel, and **archive it**.
   Proving later what someone agreed to depends on the label and the archived file matching.

### Why a code constant, not an env var or an admin screen

- An **env var** can be changed by anyone with host-dashboard access, unreviewed and untraceable.
- An **admin screen** would let MeritX ops quietly change what users agreed to — which breaks the
  rule that MeritX never reaches into the substance of the case.
- A **code constant** requires a commit with an author, a review and a deploy.

Changing a legal document should be inconvenient.

## Gate 3 — Deployment (semi-hard)

`render.pilot.yaml`:

```yaml
# DO NOT apply without the MeritX owner's approval.
autoDeploy: false                 # deploy manually only after review
```

The comment is a convention. `autoDeploy: false` is not: merging to `main` does not deploy
anything — someone has to deploy by hand. The blueprint also sits in `pilot/`, not at the repo
root, so it is not picked up automatically. Steps and costs: `docs/DEPLOYMENT.md`.

## Gates 4 and 5 — open decisions

Tracked in `docs/TODO_audit_log_and_case_destruction.md`; neither is enforced by code.

- **Anchor retention.** The access-log chain head goes to stdout and so into the host's log store,
  separate from the disk — but that store's retention is plan-limited. Before launch, either
  configure a log stream or pick an SMTP provider and enable the daily anchor email
  (`PILOT_ANCHOR_EMAIL_ENABLED`). See `docs/AUDIT_ANCHORING.md`.
- **`SESSION_TTL_SECONDS` / `MAX_UPLOAD_BYTES`.** Choose them or leave them unset for the defaults
  (8 h / 25 MB). Both are validated at startup, so a typo refuses to boot rather than silently
  breaking logins or uploads.

## Gate 6 — `LAWYER_APPROVED_PUBLISH`

Not a launch gate so much as a standing switch, but it belongs here because it is the second of the
two conditions that make an assessment visible to the employee (the first being the lawyer's own
approval). Default `false`. The lawyer and the MeritX owner decide together when it goes on.

## The order is fixed

`docs/AI_VENDOR_TERMS_CHECKLIST.md` carries this line:

> Copy the verified wording into the consent form's `[LIST VENDORS AND VERIFIED TERMS]`.
> Lawyer sign-off: ______ Date: ______

The consent document has to name the vendors and their terms, and those come out of gate 1. So:

```
verify AI vendor terms  →  write them into the consent document  →  lawyer signs off
  →  change CONSENT_VERSION  →  owner approves deployment  →  deploy  →  real data
```

Skipping ahead means asking an employee to consent to data processing whose terms nobody has read
yet.

## What "all gates open" does not mean

Even with every gate open, the standing rules still hold: no real files until the encrypted build is
deployed (`docs/DEPLOYMENT.md` step 6), the pilot host is never linked from the landing site or
sitemap, and only one person holds production access.
