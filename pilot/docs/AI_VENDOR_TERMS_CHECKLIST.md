# AI vendor terms: verification checklist (human TODO)

**Status: NOT VERIFIED.** This file makes **no claims** about any vendor's terms. Every item
below is a TODO that a person must check against the live vendor page **and** the signed
agreement for the exact account/project whose API key will be used. Record the evidence
(dated screenshots, agreement copies) in the pilot's private file, **not in this repo**.

`AI_PROVIDER` must stay `none` and `AI_PAID_TIER_VERIFIED` must stay unset until one vendor's
section is fully ticked and signed off. Free or unpaid tiers must never be used.

Link check: on 2026-10-19 an automated HTTP request got a 200 from every Google and Anthropic
link below. The openai.com links returned 403 to automated requests, which means nothing about
whether the pages exist; open them in a browser. A working link is **not** a check of the content.

## Per-vendor checklist (copy for the chosen vendor)
- [ ] TODO: Is customer API data (prompts, files, outputs) used to train or improve models on this tier? Required answer: **no**. Evidence: ______
- [ ] TODO: How long are prompts/outputs kept for abuse monitoring, and can that be shortened? Evidence: ______
- [ ] TODO: Is zero data retention (or a modified abuse-monitoring arrangement) offered? Has it been applied for and approved for our org? Evidence: ______
- [ ] TODO: Are any endpoints or features we call excluded from that arrangement? (The pilot only sends inline requests to the plain generate/messages endpoint. It never uses Files, batch, caching, or assistants APIs.) Evidence: ______
- [ ] TODO: Which data processing addendum applies, and how/when was it accepted? Evidence: ______
- [ ] TODO: Where is data processed and stored? Is US-only processing available or needed? Evidence: ______
- [ ] TODO: Is the key from a **paid** account with billing active (not a free tier or trial)? Evidence: ______
- [ ] TODO: Are uploaded images/files scanned or kept under separate rules (e.g. safety scanning) that override retention settings? Evidence: ______
- [ ] TODO: Who at MeritX holds the key? Is it limited to this pilot? What is the rotation and revocation plan? Evidence: ______
- [ ] TODO: Retention period for request data on this account, per the vendor terms, in **days** or **zero retention**: ______ days / zero retention. Evidence: ______ (destroy-case records this number: `--ack-ai-vendor-data <vendor>=<days>` or `<vendor>=zero`.)
- [ ] TODO: At case close, confirm the vendor's retained request data is deleted or the retention period above has passed, then record it in the deletion certificate (mandatory checklist item 2 of `npm run destroy-case:prod`). Evidence: ______
- [ ] TODO: Copy the verified wording into the consent form's `[LIST VENDORS AND VERIFIED TERMS]`. Lawyer sign-off: ______ Date: ______

## Where to look (links only; read the live pages)
### Google: Gemini API (`AI_PROVIDER=gemini`)
- Terms: https://ai.google.dev/gemini-api/terms
- Logging / data policy: https://ai.google.dev/gemini-api/docs/logs-policy
- Zero data retention: https://ai.google.dev/gemini-api/docs/zdr
- Pricing / tiers: https://ai.google.dev/gemini-api/docs/pricing
- Cloud data processing addendum: https://cloud.google.com/terms/data-processing-addendum
- Vertex AI data governance (alternative, not implemented): https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance

### OpenAI API (`AI_PROVIDER=openai`)
- Your data / retention controls: https://platform.openai.com/docs/guides/your-data
- Enterprise privacy: https://openai.com/enterprise-privacy/
- Data processing addendum: https://openai.com/policies/data-processing-addendum/
- Services agreement: https://openai.com/policies/services-agreement/
- Pricing: https://openai.com/api/pricing/

### Anthropic API (`AI_PROVIDER=anthropic`)
- Commercial terms: https://www.anthropic.com/legal/commercial-terms
- Data processing addendum: https://www.anthropic.com/legal/data-processing-addendum
- Retention article: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- API data retention / ZDR: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Pricing: https://www.anthropic.com/pricing

## Note on `AI_VENDOR_VERIFICATION.md`
That older doc has paraphrased vendor summaries. They have **not** been independently checked
for this checklist. Treat them as leads to confirm, not as findings.
