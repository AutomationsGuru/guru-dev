# Tests (`main/tests/`)

Vitest suites for the GuruHarness product tree. Product README badge reflects full `npm test` count (see `../README.md`).

| Area | Notes |
| --- | --- |
| Layout | One folder per `src/` subsystem (`guru/`, `tui/`, `tools/`, `memory/`, …) |
| `helpers/` | Shared test utilities (`paths.ts` — Windows path compare normalization) |
| `fixtures/` | Config samples (e.g. `litellm.config.yaml`) |
| `mcp/fixtures/` | `fake-mcp-server.mjs` — stdio MCP fake for bridge/transport tests |

Run from `main/`: `npm test` or focused `npx vitest run tests/<area>`.

**Linux filesystem:** prefer a user-owned **native ext4** (or local disk) clone for full `npm test` / vitest — SMB/CIFS mounts (e.g. workspace on network share) may block or skew results; see `../AGENTS.md` local developer install. Re-verify README test badge (**D3**) on next clean Linux native run.

**Lane:** doc-control index only — do not treat as a separate product boundary (governed by `../AGENTS.md`).