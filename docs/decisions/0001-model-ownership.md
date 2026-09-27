# 0001: Model ownership and the provider boundary

- **Status:** accepted for v0.1; to be revisited at v0.4.
- **Date:** 2026-09-27.

## Decision

- v0.1 runs in **`host_agent` mode only.** The AI host running the Skill performs all inference and submits schema-validated results through the CLI.
- miosotis calls no model and needs no API key.
- Generator metadata (`mode`, nullable `model`) is recorded on derived records and artifacts.
- Deterministic fake agents exist only in tests.

## Consequences

- Capture, retrieval, viewing, export, and backup work with no model at all.
- `miosotis review|analysis|discuss` return `capability_unavailable` without a host.
- Because the contracts (`src/contracts/`) are provider-neutral, a v0.4 runner can produce the same enrichment and artifact requests.

## Next milestone (v0.4): service and standalone AI

- A local HTTP service over the same `src/app` use cases, bound to loopback by default, with real authentication before any remote (for example Tailscale) exposure.
- Providers via the owner's `@priest-ai/core`:
  - `api_provider` (BYOK) and `local_provider` endpoints, configured separately for cheap enrichment and deeper work.
  - Credentials stay in config/secret storage, never in the database, artifacts, logs, or exports.
- Subscription sign-in (for example ChatGPT through the Codex runtime) is a separate `external_runtime` adapter, not a generic API entitlement. `@priest-ai/core` does not provide it today.

## Open questions (verify at implementation time; not verified in this session)

- The current Codex App Server authentication surface and its terms of use for a custom client.
- Whether to add subscription auth to `@priest-ai/core` or to integrate the Codex runtime directly.
- Where credentials live: `config.toml` versus the macOS Keychain.
