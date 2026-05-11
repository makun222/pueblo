# Pueblo App Modules

- `src/cli/`: CLI bootstrap and top-level command routing.
- `src/commands/`: User-facing command handlers and dispatcher integration.
- `src/providers/`: Provider registry, model selection, and adapter contracts.
- `src/sessions/`: Session lifecycle, persistence access, and query helpers.
- `src/memory/`: Memory models, repositories, services, and query helpers.
- `src/prompts/`: Prompt models, repositories, and services.
- `src/tools/`: Tool adapters and orchestration services.
- `src/agent/`: Task context and task execution orchestration.
- `src/workflow/`: Workflow routing, workflow state persistence, runtime plan storage, and workflow-specific context injection.
- `src/persistence/`: SQLite bootstrap, migrations, health checks, and shared repository helpers.
- `src/shared/`: Cross-module schemas, config loading, and result formatting.

Module boundaries must remain high-cohesion and low-coupling. Provider logic stays out of session,
memory, and prompt modules. Persistence concerns live in `src/persistence/` and repository
implementations, not in CLI handlers.

## Workflow Orchestration

- Workflow logic lives under `src/workflow/` and coordinates complex multi-round tasks without duplicating provider or session behavior.
- Runtime workflow artifacts belong in `.plans/`; they are execution state, not final repository deliverables.
- Final `.plan.md` deliverables are exported separately after workflow completion so the app project is not polluted with in-progress state.
- Active workflow plan/todo context is injected through workflow-aware context assembly, not by treating workflow state as ordinary Pepe-ranked memory.

## Desktop Shell Integration

- `src/desktop/`: Electron main process, preload bridge, and React renderer for popup window.
- Desktop shell acts as a thin view layer; all business logic (commands, providers, sessions) remains in shared core.
- IPC contracts in `src/desktop/shared/` define secure communication boundaries.
- Renderer submits input to shared routing; outputs stream back via IPC blocks.

## Provider Integration

- `src/providers/github-copilot-*.ts`: Dedicated profile, auth, and adapter for GitHub Copilot as mandatory provider.
- `src/providers/deepseek-*.ts`: DeepSeek profile, auth persistence, and OpenAI-compatible adapter.
- Auth state tracked in persistence with provider-aware migrations.
- Adapter implements provider contract for task execution and tool orchestration.
- No provider logic leaks into session, memory, or prompt modules.
