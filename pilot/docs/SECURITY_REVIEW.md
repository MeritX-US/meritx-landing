# Security / correctness review of the pilot PRs (2026-10-27)

Review of the three stacked PRs (`pilot/pr1-auth-rbac-noindex`, `pilot/pr2-encryption-signed-urls-ai`,
`pilot/pr3-audit-chain-destruction`) before any real case data is loaded. Every finding below was
reproduced before it was fixed, and each fix has a test that fails without it.

**The access-control model held up.** Nothing here was a way to read data a role is not entitled to:
`allow()` gates the route, then `src/views.ts` re-projects per role, so a handler that forgets to
filter still cannot leak a field. The findings were all at the edges — error paths, config parsing,
memory growth, and what gets shipped in the image.

## Fixed

### 1. A store error on `POST /api/assessment/generate` hung the request and killed the process
`src/app.ts` (PR2). The handler is `async`, and Express 4 ignores a rejected promise, so
`store.read()` and `store.getBlob()` sitting outside its `try` meant a blob that failed to decrypt
(rotated key, damaged disk) hung the request forever *and* raised an unhandled rejection, which on
Node 20 terminates the process. The lawyer saw nothing and nothing explained the restart.

The whole body is now wrapped with `next(e)` for the 500 path. An unreadable blob is no longer
passed on as an empty attachment either: it comes back as `unreadableMaterialIds` so the lawyer
knows which document to review by hand, and the rest of the assessment still runs.

### 2. The AI disclosure could go unrecorded
`src/app.ts` (PR2). The access-log entry was written *after* `store.update`, so if persisting the
draft failed, the disclosure went unlogged even though the case files had already reached the
vendor. For a log whose purpose is recording who saw what, that is the wrong half to lose. It is
now written as soon as `ai.generate` returns, before the save.

### 3. An assessment could be drafted with none of the chosen evidence
`src/app.ts` (PR2). If materials were selected and not one of them could be read, the request went
to the vendor anyway and produced a draft from the questionnaire alone — indistinguishable from one
that had seen the documents. It is now refused with 409, and the refusal is logged (`denied`).
Selecting no materials at all is a separate, still-allowed case.

### 4. Malformed numeric env vars became `NaN` and broke things silently
`src/config.ts` (PR1, PR2). These were `Number(env.X || default)` with no validation, while every
neighbour (`PORT`, `SMTP_PORT`, `DOWNLOAD_URL_TTL_SECONDS`, `PILOT_MAX_ACCOUNTS`) was validated:

| Variable | What a malformed value did |
|---|---|
| `SESSION_TTL_SECONDS` | `exp` serialised to `null`: login returned 200, then every request 401'd, with nothing in the logs |
| `MAX_UPLOAD_BYTES` | multer's `limits.fileSize=NaN` delivered a **0-byte file with no error**, so every upload failed as 415 |
| `AI_TIMEOUT_MS` | `setTimeout(abort, NaN)` fires immediately, aborting every AI request as it was sent |

`parseIntEnv` now refuses a non-integer or out-of-range value at startup. It accepts plain decimal
digits only (`/^\d+$/`): `Number()` reads `0x10`, `1e3`, `0b11` and `0o17` as integers, so a value
meant literally would quietly become a different number. Ranges are documented in `.env.example`.

### 5. Login-failure tracking grew without bound
`src/auth.ts` (PR1). The IP+email lockout map and the per-email backoff map are keyed by
attacker-supplied input and were pruned only on a lookup of *the same key*, so a sustained login
flood with distinct emails grew them until the instance ran out of memory, and nothing was
reclaimed without a restart. Measured: 200k attempts left 400k retained entries, ~90 MB — a real
target on a 512 MB Render starter instance, reachable unauthenticated.

Both maps are now swept for stale entries and hard-capped at `Auth.MAX_TRACKED`, evicting
oldest-first. **Allowlisted accounts are evicted last**, so a flood cannot push a real account's
lockout out of the map or reset its backoff escalation.

### 6. `fillTemplate` resolved inherited properties
`src/ai/provider.ts` (PR2). `k in vars` walks the prototype chain, so a template typo like
`{{constructor}}` or `{{toString}}` substituted a JS internal
(`function Object() { [native code] }`) into the prompt sent to the vendor. Own keys only now.

### 7. body-parser advisory
`npm audit` reported one high: body-parser `<1.20.9`, DoS via trailing bytes after a compressed
request body (GHSA-27r3-jxmh-p828), via express 4. Bumped to 1.20.9; `npm audit` is clean.

### 8. The production image shipped compiled test code
`tsconfig.json` included `test/**`, so `dist/test/**` ended up in the image that holds the case
data. `npm run build` now uses `tsconfig.build.json` (src only). CI still needs the synthetic
fixture builder, so the Dockerfile's `build` stage also emits `dist-test` and
`ci/docker-destroy-case.sh` copies it out of that stage and mounts it — `destroy-case` is still
exercised as compiled JS inside the real production image, and the script now also asserts
`dist/test` is absent. The production stage stays **last** in the Dockerfile, so a plain
`docker build` (and Render, which passes no `--target`) can only ever build it.

### 9. Test-suite portability and one flake
- Five tests failed on Windows: they spawned `node_modules/.bin/tsx` (a shell shim with no
  extension there), assumed `/`-prefixed absolute paths and `/` separators, and created a symlink
  without the privileges Windows grants by default. They now go through a `runCliScript` helper
  that resolves tsx's own entrypoint, compare platform-normalised paths, and skip the symlink case
  where the platform cannot create one. CI (ubuntu) still runs all of them.
- `verify(anchor): a fully re-generated chain of the same length is caught` was timing-dependent:
  CI caught it as a flake when the same commit passed on `push` and failed on `pull_request`. An
  entry's hash covers `[seq, ts, actor, role, action, resource, outcome]`, and the test's helper
  appended entries differing only in `ts`, so when both runs landed in the same millisecond the
  "rewritten" chain was byte-identical and `verify()` correctly reported a match. The helper now
  takes a tag so the regenerated chain differs in content, which is what the test always claimed.
  Confirmed with the clock frozen: the rewrite is caught regardless of timing.

## Looked at and deliberately left alone

- **PR1 ships plaintext storage.** Encryption arrives in PR2. The title and the README's staging
  table say so ("No (plaintext storage)"), so this is a staging decision, not a defect — but PR1's
  base is `main`, so **do not deploy from PR1 alone**. See `README.md`.
- **CSRF rests on `SameSite=Strict` plus the `Origin` check** in `strictCors`, not on a token. A
  request with no `Origin` header (a non-browser client) can still mutate. Reasonable here: the
  cookie is `__Host-`-prefixed, `SameSite=Strict` and `HttpOnly`, and browsers send `Origin` on
  state-changing requests.
- **`requireHttps` only redirects on exactly `x-forwarded-proto: http`.** A comma-joined value or
  an absent header skips the redirect. On Render the header is a single value, and HSTS is set.
- **Questionnaire answers and document contents go into the AI prompt**, so prompt injection from
  an uploaded document is possible in principle. Contained by design: the output is a draft with
  `approval: null` that only the lawyer sees until approved, and `LAWYER_APPROVED_PUBLISH` is a
  second gate.
- **`destroyCase` unlinks rather than overwrites.** The crypto-shred (deleting the key) is what
  makes the data unrecoverable, including in snapshots; overwriting is meaningless on
  copy-on-write storage anyway. Already documented in `src/destroyCase.ts`.
- **The access log is encrypted line-by-line with one AAD (`accesslog`)**, so AES-GCM alone would
  not catch reordering or deletion of whole lines. That is exactly what the hash chain is for, and
  it is documented in `src/accessLog.ts`.
- **`store.update` is read-modify-write with no lock.** Safe as written because `read`, the
  mutator and the write are all synchronous, so an update cannot interleave on the event loop.
  Worth remembering if a mutator ever becomes `async`.

## State at the end of the review

126 tests (125 pass, 1 skipped on Windows; all 126 run in CI), `npm audit` clean, typecheck clean,
and both CI jobs green on all three PRs.
