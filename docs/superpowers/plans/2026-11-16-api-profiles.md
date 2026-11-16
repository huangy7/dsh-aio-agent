# Claude Code API Profiles Implementation Plan

> Execute inline using superpowers:executing-plans. User approved implementation in this session.

**Goal:** Provide reusable connections, usable API profile management and uninterrupted Claude sessions.

**Architecture:** A versioned JSON document stores connections and profiles. Host resolves connection credentials into per-turn environment variables; the client displays profile-specific model aliases and uses native composer slots.

**Tech Stack:** Node.js, existing DSH React runtime, node:test; no new dependencies.

**Spec:** docs/superpowers/specs/2026-11-16-api-profiles-design.md

## Global Constraints

- Do not modify global Claude settings or add dependencies.
- Preserve existing profile data and CLI session bindings.
- Keep credentials out of model-list responses and errors.

## Task 1: Session continuity

- [x] Add regression to test/sessions.test.js: seed a Claude binding, select and clear profiles, assert the original chatId remains.
- [x] Run `node --import ./test/dsh-runtime.mjs --test test/sessions.test.js` and observe failure.
- [x] Remove profile-triggered binding clears in lib/driver.js; support stable profile IDs in lib/sessions.js and lib/index.js.
- [x] Extend test/driver.test.js to run two turns with a profile switch; assert both settings and --resume.

## Task 2: Connections, migration, discovery

- [x] Add test/profiles.test.js for legacy migration, shared connection edits, model names and versioned persistence.
- [x] Implement lib/profile-config.js 与 lib/profile-models.js: `profileDocument(text)`, `resolvedProfiles(text)`, `profileModels(profile)`, `fetchProfileModels(connection, fetcher)`.
- [x] Wire resolved profiles into lib/backends.js and add POST /api/aio-agent/models in lib/index.js.
- [x] Verify fetch URL construction, auth, malformed data and credential-safe failures with local fixtures.

## Task 3: Settings and composer

- [x] Replace ProfileEditor in lib/client.js with searchable profile and connection lists, focused editors, shared connection selection and model mapping.
- [x] Support staged model discovery and validation through existing SettingsFormModel.
- [x] Move profile slot to conversation.input.right; use profile data to transform modeView's model rows.
- [x] Verify display-name changes, default fallback and per-session isolation in test/client.test.js.

## Task 4: Verification

- [x] Run relevant tests and full npm test; distinguish sandbox failures from code regressions.
- [x] Browser-check settings lists, editors, model selection and composer placement.
- [x] Update README.md and README.zh.md; inspect diff and syntax before reporting completion.
