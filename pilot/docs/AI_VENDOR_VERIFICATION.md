# AI vendor verification – must be completed BEFORE `AI_PROVIDER` is switched on

> The summaries below are **unverified leads**. The sign-off checklist is [`AI_VENDOR_TERMS_CHECKLIST.md`](AI_VENDOR_TERMS_CHECKLIST.md), where every item is a human TODO.

Status: **not verified.** Nobody has signed up, paid, or requested anything. The app ships with
`AI_PROVIDER=none` and refuses to enable a provider unless `AI_PAID_TIER_VERIFIED=true` is set
by a human after this checklist is completed **for the exact account/project whose key is used**.
Paste screenshots and dates into the pilot's private file (not this repo), then copy the verified
wording into the consent form's `[LIST VENDORS AND VERIFIED TERMS]`.

Summaries below quote/paraphrase the vendor pages as fetched on 2026-10-18 and are **not**
legal conclusions. Terms change. Re-read the live pages and your signed agreement.

## What the code already does (independent of vendor)
- Sends files **inline** in the request (base64). It never calls a Files API, vector store,
  assistants/threads, batch, or explicit-cache endpoint, so nothing is left stored at the vendor
  except whatever request/abuse-monitoring logs the vendor keeps.
- OpenAI requests set `store: false`.
- Only the lawyer can trigger a call. The call needs a lawyer-chosen visa type, and the lawyer
  explicitly picks which materials are sent.
- Output is saved as an **unapproved** draft. Employees see it only after lawyer approval, and only
  if `LAWYER_APPROVED_PUBLISH=true`.
- The access log records provider, model, request id, and file count. It never records prompts or outputs.
- Transcription (AssemblyAI/Deepgram), Twilio, and grounding/search tools are **not used** in the pilot.

## Checklist (per vendor; complete for the one you choose)
| # | Question | Evidence to capture |
|---|---|---|
| 1 | Is this account/tier's data used to train or improve models? (must be **No**) | Terms page + account setting screenshot |
| 2 | Abuse-monitoring retention period for prompts/outputs; can it be reduced? | Terms/doc page |
| 3 | Is Zero Data Retention (or modified abuse monitoring) available? Applied for? Approved? | Approval email / settings screenshot |
| 4 | Are any features we call excluded from ZDR? (We should only call the plain generate endpoint) | Feature eligibility table |
| 5 | DPA in place? Which data-processing addendum applies, and how is it accepted? | DPA link + acceptance record |
| 6 | Processing/storage region; is US-only processing available/needed? | Doc page |
| 7 | Key is from a **paid** project/org (billing active), never a free/unpaid tier | Billing page screenshot |
| 8 | Who at MeritX holds the key; key scoped to this pilot only; rotation plan | Internal note |
| 9 | Deletion: confirm nothing persists beyond (2); record for the case-close certificate | Note |

## Google – Gemini API (`AI_PROVIDER=gemini`)
- Terms: https://ai.google.dev/gemini-api/terms. These say **Unpaid Services** (free quota,
  AI Studio without billing) **are used to improve products, with human review**, so they must not be used.
  For **Paid Services** (Cloud project with active billing) the terms say Google "doesn't use your prompts …
  or responses to improve our products". It processes under the Data Processing Addendum, and it "logs prompts
  and responses for a limited period of time, solely for detecting and preventing violations of the Prohibited Use Policy".
  The terms also note data "may be stored transiently or cached in any country". → Verify that period (#2) and region (#6).
- Data logging / abuse monitoring / ZDR: https://ai.google.dev/gemini-api/docs/logs-policy ,
  https://ai.google.dev/gemini-api/docs/zdr (check whether ZDR is offered for the Gemini API).
  An enterprise alternative is Vertex AI (https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance ,
  https://cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention). Vertex needs
  service-account auth and is **not implemented** in this PR.
- Files API: we don't use it. https://ai.google.dev/gemini-api/docs/files (the existing public demo does use it.)
- Data Processing Addendum: https://cloud.google.com/terms/data-processing-addendum
- Pricing: https://ai.google.dev/gemini-api/docs/pricing (the paid tier table states "Used to improve our products: No").

## OpenAI API (`AI_PROVIDER=openai`)
- Data controls: https://platform.openai.com/docs/guides/your-data. This page says API data is not used for training
  unless you opt in. By default, abuse monitoring logs are "retained for up to 30 days". ZDR and Modified Abuse
  Monitoring need **prior approval** from OpenAI sales. For `/v1/chat/completions` (the endpoint we use), the page lists
  "Data used for training: No", abuse monitoring 30 days, and ZDR eligible. Image and file inputs are scanned
  for CSAM, and flagged items can be retained even under ZDR.
- Enterprise privacy: https://openai.com/enterprise-privacy/
- DPA: https://openai.com/policies/data-processing-addendum/
- Regional endpoints (data residency): same page as above. The US needs no ZDR, other regions do. Set `AI_BASE_URL=https://us.api.openai.com` if wanted.
- Pricing: https://openai.com/api/pricing/

## Anthropic API (`AI_PROVIDER=anthropic`)
- Retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
  says API inputs/outputs are deleted "within 30 days" by default, with exceptions (Files API, ZDR agreement, Usage Policy enforcement, law).
- ZDR: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention says ZDR is enabled per organization
  via sales and covers Messages API eligible features. It does **not** cover the Console/playground. Some
  "covered models" need 30-day retention and are not ZDR-eligible (https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models).
  Flagged content may be retained longer.
- Commercial terms: https://www.anthropic.com/legal/commercial-terms (training use for commercial API is governed here)
- DPA: https://www.anthropic.com/legal/data-processing-addendum
- Pricing: https://www.anthropic.com/pricing

## Not used in pilot (verify only if re-enabled)
- AssemblyAI: https://www.assemblyai.com/legal/privacy-policy , data retention / deletion API docs
- Deepgram: https://deepgram.com/privacy , https://developers.deepgram.com/docs/data-privacy-compliance

## Cost estimate (usage-based, one case)
Assume about 30 lawyer-triggered calls × about 100k input tokens (questionnaire + several PDFs) plus about 4k output tokens.
That is about 3M input and 0.12M output tokens. At frontier list prices of about $2–4 per 1M input and $10–20 per 1M output
(Gemini/Anthropic pages, Oct 2026), this comes to **about $7–15 total for the case**. Budget **≤ $20/month**. Vendors may require
a prepaid credit (e.g. $5 minimum) or a Cloud Billing account. ZDR/enterprise agreements may carry
minimums: ask sales and don't commit without the MeritX owner's approval.
