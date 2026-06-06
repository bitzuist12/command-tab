# Roadmap

## Phase 0: Clean Fork

- Rename product surface to Command Tab.
- Preserve upstream Tab Out attribution and MIT license.
- Keep vanilla tab cleanup working.
- Add public architecture docs.
- Avoid private Hamilton-specific code.

## Phase 1: Connector Shell

- Define a local connector API contract.
- Add a small connector-card area to the new tab.
- Add health states: connected, disconnected, stale, error.
- Add example/mock connector data clearly labeled as sample/template.

## Phase 2: First Real Connectors

Recommended order:

1. Google Calendar read-only.
2. Local tasks JSON/Markdown.
3. Gmail read-only digest.
4. WhatsApp local bridge health + manual send queue.

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
