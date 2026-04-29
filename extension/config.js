// Pluks extension analytics config — public keys, safe to bundle.
// Replace at release time via `scripts/build-extension.sh` or in CI.
globalThis.PLUKS_CONFIG = {
  POSTHOG_KEY:  "phc_PLACEHOLDER_REPLACE_AT_DEPLOY",
  POSTHOG_HOST: "https://us.i.posthog.com",
  SENTRY_DSN:   "https://PLACEHOLDER_REPLACE_AT_DEPLOY@o0.ingest.sentry.io/0"
};
