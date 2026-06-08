# Roadmap

## Phase 0: Clean Fork

- Rename product surface to Command Tab.
- Preserve upstream Tab Out attribution and MIT license.
- Keep vanilla tab cleanup working.
- Add public architecture docs.
- Avoid private Hamilton-specific code.

## Phase 1: Connector Shell

- [x] Define a local connector API contract.
- [x] Add a small connector-card area to the new tab.
- [x] Add health states: connected, disconnected, stale, error.
- [x] Add example/mock connector data clearly labeled as sample/template.
- [x] Add a local task JSON connector.
- [x] Add a private context folder convention.
- [x] Add local WhatsApp/message draft and notes context cards.
- [x] Add external backend compatibility mode for the Hamilton-style prototype.
- [ ] Add connector settings UI.

## Phase 2: First Real Connectors

Recommended order:

1. Top/focus task presentation and task-to-WhatsApp modal.
2. WhatsApp manual send queue with bridge preflight.
3. Gmail read-only digest and review actions.
4. Google Calendar read-only.

Status:

- [x] Google Calendar read-only as a **native standalone** OAuth connector
  (no external backend required). One-click connect from the new tab, PKCE,
  local token storage, visible failure states.
- [x] Gmail read-only as a native standalone connector (same OAuth path,
  per-service token). Lists recent messages via the Gmail API.

See [connectors.md](connectors.md#native-google-connectors-oauth).

Items 1-2 (focus task, WhatsApp) already work in external-backend mode; the
native standalone versions are still open.

Do not add automatic sending. Keep message/email sending manual and approval-based.

## Phase 3: Local AI

- Add a model adapter interface.
- Support Ollama or llama.cpp first.
- Test local summarization/ranking on non-sensitive sample data.
- Add no-silent-fallback states for model errors.
- Explore Gemma-family quantized models for local summarization and drafting.

## Phase 4: Packaging

- Add a local connector server package.
- Add one-command dev start.
- Add desktop helper exploration.
- Add install docs for non-technical users.

## Phase 5: Public Launch

- Demo video.
- Screenshots with fake/sample data.
- Clear privacy statement.
- Connector setup docs.
- Contribution guide.

## Design Principles

- The new tab should be immediately useful before any connector setup.
- Users should always know whether a card is live, cached, sample, or errored.
- Private data should stay local unless the user explicitly connects a service.
- Local AI should assist, not pretend to be authoritative.
