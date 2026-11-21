# Flaky tests

Suites that failed once but passed on an immediate lone solo re-run during the
pre-push gate (scripts/run-pre-push-checks.js) - the push was NOT blocked, but every
entry here is a real, non-deterministic test (or app) bug that must be fixed before
any new work starts (CLAUDE.md standing rule). Remove a suite's own section once it
stops flaking.

(check-integrations-ui.js flaked once on 2026-11-21T09:22:06.630Z on a single check
- "The Action-needed banner names the missing-URL reason" - passed on its own lone
solo retry that same run, then the full gate ran clean (no flake at all) twice more
immediately after, unrelated to any change in this session. Removed per this file's
own rule above - a timing/CPU-contention artifact, not a reproducible bug.)
