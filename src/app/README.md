# Pueblo App Modules

- `src/cli/`: CLI bootstrap and top-level command routing.
- `src/commands/`: User-facing command handlers and dispatcher integration.
- `src/providers/`: Provider registry, model selection, and adapter contracts.
- `src/sessions/`: Session lifecycle, persistence access, and query helpers.
- `src/memory/`: Memory models, repositories, services, and query helpers.
- `src/prompts/`: Prompt models, repositories, and services.
- `src/tools/`: Tool adapters and orchestration services.
- `src/agent/`: Task context and task execution orchestration.
- `src/persistence/`: SQLite bootstrap, migrations, health checks, and shared repository helpers.
- `src/shared/`: Cross-module schemas, config loading, and result formatting.

Module boundaries must remain high-cohesion and low-coupling. Provider logic stays out of session,
memory, and prompt modules. Persistence concerns live in `src/persistence/` and repository
implementations, not in CLI handlers.

## Desktop Shell Integration

- `src/desktop/`: Electron main process, preload bridge, and React renderer for popup window.
- Desktop shell acts as a thin view layer; all business logic (commands, providers, sessions) remains in shared core.
- IPC contracts in `src/desktop/shared/` define secure communication boundaries.
- Renderer submits input to shared routing; outputs stream back via IPC blocks.

## GitHub Copilot Provider Integration

- `src/providers/github-copilot-*.ts`: Dedicated profile, auth, and adapter for GitHub Copilot as mandatory provider.
- Auth state tracked in persistence with provider-aware migrations.
- Adapter implements provider contract for task execution and tool orchestration.
- No provider logic leaks into session, memory, or prompt modules.
