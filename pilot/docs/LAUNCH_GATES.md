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

## Gate 2 ? Lawyer-approved consent document

The employee reads the document in the case before agreeing. Store the approved UTF-8 plain-text
file in the host's private files and set `PILOT_CONSENT_FILE` to its path. Set
`PILOT_CONSENT_VERSION` to a stable ID for that approved version. The agreement records the
employee account, timestamp, version, and SHA-256 digest.

1. The lawyer finalises the document after reviewing the relevant vendor terms and approves the text.
2. Archive that copy and set the private file path and version on the production service.
3. After deployment, check the employee view using fictional test data. Verify that the full text and
   version are displayed, and that the questionnaire opens after agreement.

Updating the text or version requires a new agreement for intake. If the production document is
missing, the employee sees a message to contact their attorney. The synthetic preview displays a
separately labelled sample.

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
  →  configure the approved file and version  →  owner approves deployment  →  deploy  →  real data
```

Skipping ahead means asking an employee to consent to data processing whose terms nobody has read
yet.

## What "all gates open" does not mean

Even with every gate open, the standing rules still hold: no real files until the encrypted build is
deployed (`docs/DEPLOYMENT.md` step 6), the pilot host is never linked from the landing site or
sitemap, and only one person holds production access.
