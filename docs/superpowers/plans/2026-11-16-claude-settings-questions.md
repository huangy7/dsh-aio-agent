# Claude settings and user questions implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The user approved this design in conversation.

**Goal:** Align profile fields and session settings snapshots with Claudia, and let Claude ask questions in the desktop App while keeping per-turn processes and resume IDs.

**Architecture:** Profiles describe typed settings overrides in addition to shared connections and model mappings. Each DSH session captures a private complete settings baseline on first launch; each turn overlays current profile fields on that baseline, preserving unrelated settings. A bidirectional Claude stream controller handles initialization, tool permission/question callbacks and cancellation; questions use DSH userQuestions.ask and their replies return to the same process.

**Constraints:** Preserve all existing uncommitted changes; no global Claude settings edits, credentials in records, new terminal UI, or automatic App restart. Keep working in the current authorized dev workspace. Explicit defaults and clears are distinct from absent/inherit values. Preserve project/local precedence when taking the effective baseline; avoid duplicate hooks by using the complete captured settings as the sole file-settings source. Only Claude Code changes transport; other backends retain their behavior.

## Tasks

- [x] 1. Profile fields and settings snapshots. Own profile-config/client/claude-settings and new claude-session-settings module, their focused tests and model endpoint. Add effort, timeout, output limit, beta/traffic controls, attribution, permissions. Preserve old JSON. Snapshot full settings privately and apply only managed overrides, with credentials never entering session events or profile endpoints. Verify inheritance, clear, editing, resume and model metadata.
- [x] 2. Claude control protocol. Own new claude-control module and tests/fixture. Implement initialize, can_use_tool and hook callbacks, request correlation, question/answer conversion, result/input closure and cancellation. Verify exact input/output with a fake process and inspect actual installed CLI protocol. Host questions must work even when permission bypass is enabled.
- [x] 3. Driver integration. Own driver/backends and agent-runtime/mock-agent tests. Wire snapshot settings and bidirectional transport to existing writer, DSH question service and permission policy. Preserve every CLI binding across questions and profile changes. Verify answers within the same turn, stop while waiting, multiple rounds and all other backends.
- [x] 4. Review, complete regressions and App installation. Review each module and complete integrated behavior; run full suite outside sandbox, regenerate embedded helpers, check syntax/diffs. Sync tested files to installed desktop plugin after backing them up. Report reload requirement and actual verification limits.

## Execution ledger

Ruling: reuse this dev workspace because it contains the user's approved prior work and is the App plugin source; a separate worktree would omit those changes.

| Interface | Producer | Consumer | Check |
| --- | --- | --- | --- |
| typed profile overrides and snapshot settings | Task 1 | Task 3 | driver consumes resolved profile; no secrets persisted in transcript |
| runClaudeTurn and control callbacks | Task 2 | Task 3 | callbacks take signal; result closes input without abandoning pending replies |
| effective model metadata | Task 1 | existing client/endpoint | labels and actual settings share the snapshot baseline |
| profile JSON/UI | Task 1 | Task 1 | validate before save; inherit/clear are explicit |
| new CLI args | Task 3 | Task 2 | host permission routing plus initialized hook callback independent of bypass |

Preflight: tasks have distinct file ownership except agreed integration interfaces; each deliverable has behavioral regression tests. No commit is needed to test or sync the user's workspace.


## Final validation and installation

- Final full suite outside sandbox: 213 tests, 207 passed, 6 skipped, 0 failed. After regenerating shared browser helpers, all 30 client tests passed again. Source and installed JavaScript syntax checks passed.
- Integrated regressions cover complete baseline inheritance, profile changes preserving resume, question replies in the same process, cancellation, early CLI binding, and failed spawn leaving the baseline unfrozen.
- Actual installed Claude CLI 2.1.322 completed an AskUserQuestion round trip against a local Anthropic SSE mock in bypass mode: one question, two model calls, tool answer observed. Isolated home/config and fake credentials; no real model requests.
- Review findings fixed: conflicting inherited authentication, atomic snapshot publication, early binding, and snapshot publication only after successful spawn. Final review found no confirmed important flaws.
- Browser fixture uses installed DSH React/CSS and fake profiles. Named field edits verified; final desktop layout has two columns, 390px viewport has one column and no horizontal overflow. Screenshots: `/private/tmp/aio-settings-desktop-final.png`, `/private/tmp/aio-settings-narrow-final.png`. Browser task closed and fixture server stopped.
- Installed 10 changed files into the desktop plugin and compared all 32 runtime/package/documentation files with source. Backup: `/private/tmp/dsh-aio-desktop-backup-1794817325349`.
- No global settings changed, no App restart, no commit or push. Actual App window needs restart and user acceptance; fixture checks do not constitute App window verification.
