#!/usr/bin/env bash
# Runs the COMPILED destroy-case script inside the PRODUCTION image against a synthetic fixture
# data dir: dry run, refusal, execute (incomplete without the checklist acks), then the
# acknowledgement run that completes the case-close. Used by .github/workflows/pilot-ci.yml.
#   bash pilot/ci/docker-destroy-case.sh [prod-image] [build-stage-image]
set -euo pipefail
IMAGE="${1:-meritx-private-pilot:ci}"
BUILD_IMAGE="${2:-meritx-private-pilot:build}"   # the Dockerfile's `build` stage
DOCKER="${DOCKER:-docker}"   # e.g. DOCKER="sudo docker" locally
WORK="$(mktemp -d)"
mkdir -p "$WORK/data"
trap 'rm -rf "$WORK"' EXIT

# Same uid as the runner so the container can delete the fixture files; HOME for npm.
run() {
  $DOCKER run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e PILOT_ENCRYPTION_KEY_FILE=/work/pilot.key \
    -v "$WORK/data:/data" -v "$WORK:/work" "$IMAGE" "$@"
}
# The fixture builder is compiled test code, so it is NOT in the image. It is mounted under
# /pilot so that Node still resolves the image's own node_modules from it.
run_with_tests() {
  $DOCKER run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e PILOT_ENCRYPTION_KEY_FILE=/work/pilot.key \
    -v "$WORK/data:/data" -v "$WORK:/work" -v "$WORK/dist-test:/pilot/dist-test" "$IMAGE" "$@"
}
fail() { echo "FAIL: $*" >&2; exit 1; }
j() { node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(eval(process.argv[2])))" "$1" "$2"; }

echo "--- image contains the compiled scripts and no test code"
run test -f dist/src/scripts/destroy-case.js || fail "dist/src/scripts/destroy-case.js missing from image"
run test -f dist/src/scripts/verify-access-log.js || fail "dist/src/scripts/verify-access-log.js missing from image"
run sh -c '! test -e node_modules/tsx' || fail "dev dependency tsx present in production image"
run sh -c '! test -e dist/test' || fail "compiled test code present in production image"

echo "--- synthetic fixture (random CI-only key), from test code kept out of the image"
BUILDER="$($DOCKER create "$BUILD_IMAGE")"
$DOCKER cp "$BUILDER:/pilot/dist-test" "$WORK/dist-test" >/dev/null
$DOCKER rm -v "$BUILDER" >/dev/null
run_with_tests node dist-test/test/fixtures/make-destroy-fixture.js /data
test -f "$WORK/pilot.key" || fail "fixture key not created"
ls -la "$WORK/data" "$WORK/data/blobs"

echo "--- verify-access-log:prod (read-only)"
run npm run --silent verify-access-log:prod -- --data-dir /data > "$WORK/verify.json" || fail "verify exited non-zero"
[ "$(j "$WORK/verify.json" 'r.ok')" = "true" ] || fail "chain not ok"

echo "--- dry run (default) deletes nothing"
run npm run --silent destroy-case:prod -- --data-dir /data > "$WORK/dry.json"
cat "$WORK/dry.json"
[ "$(j "$WORK/dry.json" 'r.dryRun')" = "true" ] || fail "not a dry run"
[ "$(j "$WORK/dry.json" 'r.caseStatus')" = '"closed"' ] || fail "case status not read as closed"
[ "$(j "$WORK/dry.json" 'r.files.filter(f=>!f.startsWith("/")).length')" = "5" ] || fail "expected 5 artefacts"
[ "$(j "$WORK/dry.json" 'r.pendingConfirmations.length')" = "2" ] || fail "checklist not pending"
test -f "$WORK/data/state.enc" || fail "dry run deleted state.enc"

echo "--- execute without the confirm phrase is refused (exit 1)"
set +e; run npm run --silent destroy-case:prod -- --data-dir /data --execute >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = "1" ] || fail "expected exit 1, got $rc"
test -f "$WORK/data/state.enc" || fail "refused run deleted data"

echo "--- execute without checklist acks: data deleted, NOT complete (exit 3)"
set +e; run npm run --silent destroy-case:prod -- --data-dir /data --execute --confirm destroy-closed-case > "$WORK/exec.json"; rc=$?; set -e
cat "$WORK/exec.json"
[ "$rc" = "3" ] || fail "expected exit 3, got $rc"
[ "$(j "$WORK/exec.json" 'r.deleted')" = "5" ] || fail "expected 5 deleted"
[ "$(j "$WORK/exec.json" 'r.complete')" = "false" ] || fail "must not be complete"
[ "$(ls -A "$WORK/data")" = "unrelated-notes.md" ] || fail "unexpected leftovers: $(ls -A "$WORK/data")"
test ! -e "$WORK/pilot.key" || fail "key file not deleted"

echo "--- acknowledgement run on the emptied dir completes the case-close (exit 0)"
run npm run --silent destroy-case:prod -- --data-dir /data --execute --confirm destroy-closed-case --force \
  --ack-render-snapshots-deleted --ack-ai-vendor-data none=zero --report-file /work/report.json > /dev/null
[ "$(j "$WORK/report.json" 'r.complete')" = "true" ] || fail "not complete"
[ "$(j "$WORK/report.json" 'r.checklist[1].vendors[0].retention')" = '"zero retention"' ] || fail "retention not recorded"

echo "OK: destroy-case runs from compiled JS in the production image"
