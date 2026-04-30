#!/usr/bin/env node

import type { AppConfig } from '../shared/config';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { createTaskContext } from '../agent/task-context';
import { AgentInstanceRepository } from '../agent/agent-instance-repository';
import { AgentInstanceService } from '../agent/agent-instance-service';
import { ContextResolver } from '../agent/context-resolver';
import { AgentTaskRepository } from '../agent/task-repository';
import { AgentTaskRunner } from '../agent/task-runner';
import { InputRouter } from '../commands/input-router';
import { createModelCommand } from '../commands/model-command';
import { createProviderConfigCommand } from '../commands/provider-config-command';
import {
  createMemoryAddCommand,
  createMemoryListCommand,
  createMemorySearchCommand,
  createMemorySelectCommand,
} from '../commands/memory-command';
import {
  createPromptAddCommand,
  createPromptDeleteCommand,
  createPromptListCommand,
  createPromptSelectCommand,
} from '../commands/prompt-command';
import {
  createNewSessionCommand,
  createSessionListCommand,
} from '../commands/session-list-command';
import {
  createSessionArchiveCommand,
  createSessionDeleteCommand,
  createSessionImportMemoriesCommand,
  createSessionRestoreCommand,
  createSessionSelectCommand,
} from '../commands/session-state-command';
import { CommandDispatcher, createCommandSelectionState, registerCoreCommands } from '../commands/dispatcher';
import { verifyPersistence } from '../persistence/health-check';
import { createSqliteDatabase } from '../persistence/sqlite';
import { DeepSeekAdapter } from '../providers/deepseek-adapter';
import { resolveDeepSeekApiKey, resolveDeepSeekAuth } from '../providers/deepseek-auth';
import { createDeepSeekProfile } from '../providers/deepseek-profile';
import { GitHubCopilotAdapter } from '../providers/github-copilot-adapter';
import {
  persistGitHubCopilotDeviceAuth,
  pollGitHubDeviceAccessToken,
  requestGitHubDeviceCode,
  type GitHubCopilotDeviceFlowDependencies,
} from '../providers/github-copilot-device-flow';
import { resolveGitHubCopilotAuth, resolveGitHubCopilotToken } from '../providers/github-copilot-auth';
import { createDefaultCredentialStore, type CredentialStore } from '../providers/credential-store';
import { createGitHubCopilotProfile } from '../providers/github-copilot-profile';
import { InMemoryProviderAdapter } from '../providers/provider-adapter';
import { ProviderError } from '../providers/provider-errors';
import { ModelService } from '../providers/model-service';
import { createProviderProfile } from '../providers/provider-profile';
import { ProviderRegistry } from '../providers/provider-registry';
import { loadAppConfig } from '../shared/config';
import {
  extractTaskOutputSummaryPayload,
  extractTaskOutputSummaryText,
  failureResult,
  formatCommandResult,
  formatError,
  summarizeModelMessageTrace,
  successResult,
} from '../shared/result';
import { MemoryRepository } from '../memory/memory-repository';
import { MemoryService } from '../memory/memory-service';
import { PromptRepository } from '../prompts/prompt-repository';
import { PromptService } from '../prompts/prompt-service';
import { SessionRepository } from '../sessions/session-repository';
import { SessionService } from '../sessions/session-service';
import { ToolInvocationRepository } from '../tools/tool-invocation-repository';
import { ToolService } from '../tools/tool-service';
import type { DesktopProviderStatuses, DesktopRuntimeStatus } from '../desktop/shared/ipc-contract';
import type { AgentProfileTemplate } from '../shared/schema';

export async function main(argv: string[] = process.argv): Promise<void> {
  const config = loadAppConfig();

  await startCliMode(config, argv);
}

const INTERACTIVE_PROMPT = 'pueblo> ';
const INTERACTIVE_EXIT_COMMANDS = new Set(['/exit', '/quit']);

async function startCliMode(config: ReturnType<typeof loadAppConfig>, argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name('pueblo')
    .description('Pueblo CLI foundation')
    .argument('[commandInput]', 'slash command to execute')
    .action(async (commandInput?: string) => {
      let resolvedConfig = config;

      if (!commandInput) {
        if (resolvedConfig.desktopWindow.enabled) {
          await launchDesktopDialog(resolvedConfig);
          return;
        }

        const cli = createCliDependencies(resolvedConfig);

        try {
          await runInteractiveCliSession(cli);
        } finally {
          cli.databaseClose();
        }

        return;
      }

      const { dispatcher, databaseClose } = createCliDependencies(resolvedConfig);

      try {
        const result = await dispatcher.dispatch({ input: commandInput });
        process.stdout.write(formatCommandResult(result));
      } finally {
        databaseClose();
      }
    });

  await program.parseAsync(argv);
}

export interface CliDependencies {
  readonly dispatcher: CommandDispatcher;
  readonly submitInput: (input: string) => Promise<import('../shared/result').CommandResult<unknown>>;
  readonly getRuntimeStatus: () => DesktopRuntimeStatus;
  readonly listAgentProfiles: () => AgentProfileTemplate[];
  readonly startAgentSession: (profileId: string) => DesktopRuntimeStatus;
  readonly setProgressReporter: (reporter: ((message: string) => void) | null) => void;
  readonly databaseClose: () => void;
}

export interface CreateCliDependenciesOptions {
  readonly startNewSession?: boolean;
  readonly deferAgentSelection?: boolean;
  readonly credentialStore?: CredentialStore;
}

export interface InteractiveCliSessionOptions {
  readonly prompt?: string;
  readonly readLine?: (prompt: string) => Promise<string>;
  readonly write?: (text: string) => void;
  readonly isInteractive?: boolean;
}

export interface DesktopDialogLaunchOptions {
  readonly cwd?: string;
  readonly electronBinary?: string;
  readonly spawnImpl?: typeof spawn;
  readonly write?: (text: string) => void;
}

export interface CliStartupSetupResult {
  readonly performed: boolean;
  readonly configured: boolean;
  readonly config: AppConfig;
  readonly errorMessage?: string;
}

interface CliStartupSetupOptions extends Pick<GitHubCopilotDeviceFlowDependencies, 'credentialStore'> {
  readonly openUrl?: (url: string) => Promise<void>;
  readonly reportProgress?: (message: string) => void;
}

export async function runInteractiveCliSession(
  cli: CliDependencies,
  options: InteractiveCliSessionOptions = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => {
    process.stdout.write(text);
  });
  const interactive = options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lineReader = options.readLine
    ? { readLine: options.readLine, close: () => {} }
    : createTerminalLineReader();

  write('Pueblo CLI foundation ready\n');

  if (!interactive) {
    lineReader.close();
    return;
  }

  write('Enter /help for commands, type a slash command or plain-text task, or use /exit to quit.\n');

  try {
    while (true) {
      const input = await lineReader.readLine(options.prompt ?? INTERACTIVE_PROMPT);
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        continue;
      }

      if (INTERACTIVE_EXIT_COMMANDS.has(trimmedInput)) {
        write('Exiting Pueblo CLI.\n');
        return;
      }

      const result = await cli.submitInput(trimmedInput);
      write(formatCommandResult(result));
    }
  } finally {
    lineReader.close();
  }
}

export async function launchDesktopDialog(
  config: AppConfig,
  options: DesktopDialogLaunchOptions = {},
): Promise<void> {
  if (!config.desktopWindow.enabled) {
    return;
  }

  const write = options.write ?? ((text: string) => {
    process.stdout.write(text);
  });
  const projectRoot = resolveProjectRoot(options.cwd ?? process.cwd());
  const electronBinary = options.electronBinary ?? resolveElectronBinary();
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(electronBinary, [projectRoot], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
  write('Opening Pueblo desktop dialog...\n');
}

export async function maybeRunCliStartupSetup(
  config: AppConfig,
  options: CliStartupSetupOptions = {},
): Promise<CliStartupSetupResult> {
  if (!shouldRunGitHubCopilotCliSetup(config)) {
    return {
      performed: false,
      configured: true,
      config,
      errorMessage: undefined,
    };
  }

  process.stdout.write('GitHub Copilot is not configured for CLI use. Starting device login flow...\n');

  try {
    const deviceCode = await requestGitHubDeviceCode(config);
    await openVerificationUrl(deviceCode.verification_uri, options.openUrl);
    options.reportProgress?.(`Open ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`);
    process.stdout.write(`Open ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}\n`);
    process.stdout.write('Waiting for GitHub authorization...\n');

    const token = await pollGitHubDeviceAccessToken(config, deviceCode);
    persistGitHubCopilotDeviceAuth(config, token.accessToken, { credentialStore: options.credentialStore });
    const nextConfig = loadAppConfig();

    process.stdout.write('GitHub Copilot authentication saved for future CLI and desktop sessions\n');

    return {
      performed: true,
      configured: true,
      config: nextConfig,
      errorMessage: undefined,
    };
  } catch (error) {
    process.stdout.write(formatCommandResult(formatError(error)));

    return {
      performed: true,
      configured: false,
      config,
      errorMessage: error instanceof Error ? error.message : 'GitHub Copilot login failed.',
    };
  }
}

async function openVerificationUrl(
  verificationUrl: string,
  openUrl: ((url: string) => Promise<void>) | undefined,
): Promise<void> {
  const open = openUrl ?? defaultOpenUrl;

  try {
    await open(verificationUrl);
  } catch {
    // Manual fallback remains available via the printed verification URL.
  }
}

async function defaultOpenUrl(url: string): Promise<void> {
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });

  child.unref();
}

export function createCliDependencies(
  config: AppConfig = loadAppConfig(),
  options: CreateCliDependenciesOptions = {},
): CliDependencies {
  let currentConfig = config;
  let progressReporter: ((message: string) => void) | null = null;
  const credentialStore = options.credentialStore ?? createDefaultCredentialStore();
  const database = createSqliteDatabase({ dbPath: config.databasePath });
  const dispatcher = new CommandDispatcher();
  const selectionState = createCommandSelectionState();
  const providerRegistry = new ProviderRegistry();
  const githubCopilotAuth = resolveGitHubCopilotAuth(currentConfig, { credentialStore });
  const deepSeekAuth = resolveDeepSeekAuth(currentConfig, { credentialStore });
  const fallbackProviders = currentConfig.providers.length > 0
    ? currentConfig.providers
    : [createFallbackProviderSetting(currentConfig.defaultProviderId, githubCopilotAuth.credentialSource, deepSeekAuth.credentialSource)];
  const providerSettings = fallbackProviders.some((provider) => provider.providerId === 'github-copilot')
    ? fallbackProviders
    : [
        ...fallbackProviders,
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: githubCopilotAuth.credentialSource,
        },
      ];

  for (const providerSetting of providerSettings) {
    if (!providerSetting.enabled) {
      continue;
    }

    if (providerSetting.providerId === 'github-copilot') {
      registerGitHubCopilotProvider(providerRegistry, currentConfig, credentialStore);
      continue;
    }

    if (providerSetting.providerId === 'deepseek') {
      registerDeepSeekProvider(providerRegistry, currentConfig, providerSetting.defaultModelId, credentialStore);
      continue;
    }

    const profile = createProviderProfile({
      id: providerSetting.providerId,
      name: providerSetting.providerId,
      authState: 'configured',
      defaultModelId: providerSetting.defaultModelId,
      models: [
        {
          id: providerSetting.defaultModelId,
          name: providerSetting.defaultModelId,
          supportsTools: true,
        },
      ],
    });

    providerRegistry.register(profile, new InMemoryProviderAdapter(profile.id, 'Task completed'));
  }

  const modelService = new ModelService(providerRegistry);
  const taskRepository = new AgentTaskRepository({ connection: database.connection });
  const promptRepository = new PromptRepository({ connection: database.connection });
  const memoryRepository = new MemoryRepository({ connection: database.connection });
  const agentInstanceRepository = new AgentInstanceRepository({ connection: database.connection });
  const promptService = new PromptService(promptRepository);
  const memoryService = new MemoryService(memoryRepository);
  const agentInstanceService = new AgentInstanceService(agentInstanceRepository);
  const toolInvocationRepository = new ToolInvocationRepository({ connection: database.connection });
  const toolService = new ToolService({ repository: toolInvocationRepository, cwd: process.cwd() });
  const taskRunner = new AgentTaskRunner(providerRegistry, taskRepository, toolService);
  const sessionRepository = new SessionRepository({ connection: database.connection });
  const sessionService = new SessionService(sessionRepository, memoryService);
  const contextResolver = new ContextResolver({
    config: currentConfig,
    sessionService,
    promptService,
    memoryService,
    agentInstanceService,
    providerRegistry,
  });
  let lastModelMessageCount = 0;
  let lastModelMessageCharCount = 0;
  let activeAgentInstanceId: string | null = null;
  let activeAgentProfileId: string | null = options.deferAgentSelection ? null : (currentConfig.defaultAgentProfileId ?? 'code-master');

  const runTask = async (goal: string, inputContextSummary: string) => {
    const trimmedGoal = goal.trim();

    if (!trimmedGoal) {
      return failureResult('TASK_GOAL_REQUIRED', 'Task goal is required', ['Provide a task goal and retry.']);
    }

    const resolvedContext = contextResolver.resolve({
      activeSessionId: selectionState.sessionId ?? currentConfig.defaultSessionId,
      explicitProviderId: selectionState.providerId,
      explicitModelId: selectionState.modelId,
      pendingUserInput: trimmedGoal,
      cwd: process.cwd(),
    });
    const providerId = resolvedContext.taskContext.providerId;
    const modelId = resolvedContext.taskContext.selectedModelId;

    if (!providerId || !modelId) {
      return failureResult('MODEL_SELECTION_REQUIRED', 'Select a provider model before running a task', [
        'Use /model to choose a provider and model.',
      ]);
    }

    let sessionId = resolvedContext.taskContext.sessionId;
    if (!sessionId) {
      const session = sessionService.createSession(createSessionTitle(trimmedGoal), modelId, ensureAgentInstance());
      sessionId = session.id;
      syncSelectionFromSession(sessionId);
    }

    const executionContext = contextResolver.resolve({
      activeSessionId: sessionId,
      explicitProviderId: selectionState.providerId,
      explicitModelId: selectionState.modelId,
      pendingUserInput: trimmedGoal,
      cwd: process.cwd(),
    });

    sessionService.addUserMessage(sessionId, trimmedGoal);

    try {
      const task = await taskRunner.run({
        goal: trimmedGoal,
        sessionId,
        providerId,
        modelId,
        inputContextSummary: JSON.stringify({
          trigger: inputContextSummary,
          contextCount: executionContext.taskContext.contextCount,
          puebloProfilePath: executionContext.taskContext.puebloProfile.loadedFromPath,
          selectedPromptIds: executionContext.taskContext.selectedPromptIds,
          selectedMemoryIds: executionContext.taskContext.selectedMemoryIds,
        }),
        taskContext: executionContext.taskContext,
        prompts: executionContext.taskContext.prompts,
        memories: executionContext.taskContext.memories,
      });

      const outputPayload = extractTaskOutputSummaryPayload(task.outputSummary);
      const messageTraceTotals = summarizeModelMessageTrace(outputPayload?.modelMessageTrace);
      lastModelMessageCount = messageTraceTotals.messageCount;
      lastModelMessageCharCount = messageTraceTotals.messageCharCount;

      for (const toolResult of outputPayload?.toolResults ?? []) {
        sessionService.addToolMessage(sessionId, toolResult.toolName, `${toolResult.status}: ${toolResult.summary}`, task.id);
      }

      const assistantOutput = extractTaskOutputSummaryText(task.outputSummary);
      if (assistantOutput) {
        sessionService.addAssistantMessage(sessionId, assistantOutput, task.id);
      }

      const turnMemory = memoryService.createConversationTurnMemory({
        sessionId,
        turnNumber: memoryService.listSessionMemories(sessionId).length + 1,
        userInput: trimmedGoal,
        assistantOutput: assistantOutput ?? 'No assistant output recorded.',
      });
      sessionService.addSelectedMemory(sessionId, turnMemory.id);

      return successResult('TASK_COMPLETED', 'Agent task completed', task);
    } catch (error) {
      if (error instanceof ProviderError) {
        sessionService.addAssistantMessage(sessionId, `Task failed: ${error.message}`);
        const turnMemory = memoryService.createConversationTurnMemory({
          sessionId,
          turnNumber: memoryService.listSessionMemories(sessionId).length + 1,
          userInput: trimmedGoal,
          assistantOutput: `Task failed: ${error.message}`,
        });
        sessionService.addSelectedMemory(sessionId, turnMemory.id);
        return failureResult('TASK_RUN_FAILED', error.message, [
          'Use /model to review the active provider configuration.',
          'Use /provider-config github-copilot login when GitHub Copilot credentials are missing.',
          'Use /provider-config deepseek set-key <apiKey> [defaultModelId] [baseUrl] to configure DeepSeek access.',
        ]);
      }

      throw error;
    }
  };
  const inputRouter = new InputRouter({
    dispatcher,
    runTaskFromText: (text) => runTask(text, 'Plain-text task execution'),
  });

  const syncSelectionFromSession = (sessionId: string | null): void => {
    selectionState.sessionId = sessionId;

    if (!sessionId) {
      selectionState.modelId = null;
      activeAgentInstanceId = null;
      return;
    }

    const session = sessionService.getSession(sessionId);
    activeAgentInstanceId = session?.agentInstanceId ?? null;
    activeAgentProfileId = agentInstanceService.getAgentInstance(activeAgentInstanceId)?.profileId ?? activeAgentProfileId;

    const resolved = contextResolver.resolve({
      activeSessionId: sessionId,
      explicitProviderId: selectionState.providerId,
      explicitModelId: selectionState.modelId,
      cwd: process.cwd(),
    });
    selectionState.providerId = resolved.runtimeStatus.providerId;
    selectionState.modelId = resolved.runtimeStatus.modelId;
  };

  registerCoreCommands(dispatcher);
  const handleCurrentSessionChange = (sessionId: string | null): void => {
    syncSelectionFromSession(sessionId);
  };

  dispatcher.register('/new', createNewSessionCommand({
    sessionService,
    getAgentInstanceId: () => activeAgentInstanceId,
    onCurrentSessionChange: handleCurrentSessionChange,
  }));
  dispatcher.register('/session-list', createSessionListCommand({ sessionService }));
  dispatcher.register('/session-sel', createSessionSelectCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-archive', createSessionArchiveCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-restore', createSessionRestoreCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-del', createSessionDeleteCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-import-memories', createSessionImportMemoriesCommand({
    sessionService,
    onCurrentSessionChange: handleCurrentSessionChange,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/prompt-list', createPromptListCommand({
    promptService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/prompt-add', createPromptAddCommand({
    promptService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/prompt-sel', createPromptSelectCommand({
    promptService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/prompt-del', createPromptDeleteCommand({
    promptService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/memory-list', createMemoryListCommand({
    memoryService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/memory-add', createMemoryAddCommand({
    memoryService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/memory-sel', createMemorySelectCommand({
    memoryService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  dispatcher.register('/memory-search', createMemorySearchCommand({
    memoryService,
    sessionService,
    getCurrentSessionId: () => selectionState.sessionId,
  }));
  const providerConfigCommand = createProviderConfigCommand({
    getCurrentConfig: () => currentConfig,
    setCurrentConfig: (nextConfig) => {
      currentConfig = nextConfig;
    },
    credentialStore,
    runGitHubCopilotLogin: () => maybeRunCliStartupSetup(currentConfig, {
      credentialStore,
      reportProgress: progressReporter ?? undefined,
    }),
    onConfigured: (providerId, nextConfig) => {
      if (providerId === 'deepseek') {
        registerDeepSeekProvider(
          providerRegistry,
          nextConfig,
          nextConfig.providers.find((provider) => provider.providerId === 'deepseek')?.defaultModelId,
          credentialStore,
        );
        applyConfiguredProviderSelection('deepseek', nextConfig);
        return;
      }

      if (providerId === 'github-copilot') {
        registerGitHubCopilotProvider(providerRegistry, nextConfig, credentialStore);
        applyConfiguredProviderSelection('github-copilot', nextConfig);
      }
    },
  });
  dispatcher.register('/provider-config', providerConfigCommand);
  dispatcher.register('/auth-deepseek', (args) => providerConfigCommand(['deepseek', 'set-key', ...args]));
  dispatcher.register('/auth-login', () => providerConfigCommand(['github-copilot', 'login']));
  dispatcher.register(
    '/model',
    createModelCommand({
      modelService,
      getCurrentSessionId: () => selectionState.sessionId,
      setCurrentSessionModel: (sessionId: string, modelId: string): void => {
        sessionService.setCurrentModel(sessionId, modelId);
      },
      setSelection(providerId: string, modelId: string): void {
        selectionState.providerId = providerId;
        selectionState.modelId = modelId;
      },
    }),
  );
  dispatcher.register('/task-run', async (args) => {
    return runTask(args.join(' '), 'CLI task execution');
  });

  verifyPersistence(database, currentConfig.databasePath);
  const currentSession = options.startNewSession && !options.deferAgentSelection
    ? sessionService.createSession('Desktop session', null, ensureAgentInstance())
    : sessionService.getCurrentSession();
  selectionState.sessionId = currentSession?.id ?? currentConfig.defaultSessionId;
  selectionState.providerId = currentConfig.defaultProviderId;
  selectionState.modelId = currentSession?.currentModelId ?? null;
  syncSelectionFromSession(selectionState.sessionId);

  return {
    dispatcher,
    submitInput(input: string) {
      return inputRouter.route(input);
    },
    getRuntimeStatus() {
      const runtimeStatus = contextResolver.resolve({
        activeSessionId: selectionState.sessionId ?? currentConfig.defaultSessionId,
        explicitProviderId: selectionState.providerId,
        explicitModelId: selectionState.modelId,
        cwd: process.cwd(),
      }).runtimeStatus;

      return {
        ...runtimeStatus,
        agentProfileId: runtimeStatus.agentProfileId ?? activeAgentProfileId,
        agentProfileName: runtimeStatus.agentProfileName ?? agentInstanceService.getProfileTemplate(activeAgentProfileId ?? '')?.name ?? null,
        agentInstanceId: runtimeStatus.agentInstanceId ?? activeAgentInstanceId,
        modelMessageCount: lastModelMessageCount,
        modelMessageCharCount: lastModelMessageCharCount,
        availableProviders: providerRegistry.listProfiles(),
        providerStatuses: buildDesktopProviderStatuses(currentConfig, credentialStore),
      };
    },
    listAgentProfiles() {
      return agentInstanceService.listProfileTemplates();
    },
    startAgentSession(profileId: string) {
      activeAgentProfileId = profileId;
      const agentInstance = agentInstanceService.markActive(
        agentInstanceService.createAgentInstance(profileId, process.cwd()).id,
      );
      activeAgentInstanceId = agentInstance.id;
      const session = sessionService.createSession(`${agentInstance.profileName} session`, selectionState.modelId, agentInstance.id);
      syncSelectionFromSession(session.id);
      return this.getRuntimeStatus();
    },
    setProgressReporter(reporter: ((message: string) => void) | null): void {
      progressReporter = reporter;
    },
    databaseClose(): void {
      database.close();
    },
  };

  function ensureAgentInstance(): string {
    if (activeAgentInstanceId) {
      return activeAgentInstanceId;
    }

    const profileId = activeAgentProfileId ?? currentConfig.defaultAgentProfileId ?? 'code-master';
    const agentInstance = agentInstanceService.markActive(
      agentInstanceService.createAgentInstance(profileId, process.cwd()).id,
    );
    activeAgentProfileId = agentInstance.profileId;
    activeAgentInstanceId = agentInstance.id;
    return agentInstance.id;
  }

  function applyConfiguredProviderSelection(providerId: 'github-copilot' | 'deepseek', nextConfig: AppConfig): void {
    const configuredProvider = nextConfig.providers.find((provider) => provider.providerId === providerId && provider.enabled);
    const defaultModelId = configuredProvider?.defaultModelId
      ?? (providerId === 'github-copilot' ? 'copilot-chat' : 'deepseek-v4-flash');

    selectionState.providerId = providerId;
    selectionState.modelId = defaultModelId;

    if (selectionState.sessionId) {
      sessionService.setCurrentModel(selectionState.sessionId, defaultModelId);
      syncSelectionFromSession(selectionState.sessionId);
    }
  }

  function buildDesktopProviderStatuses(
    config: AppConfig,
    store: CredentialStore,
  ): DesktopProviderStatuses {
    const githubProvider = config.providers.find((provider) => provider.providerId === 'github-copilot');
    const deepSeekProvider = config.providers.find((provider) => provider.providerId === 'deepseek');
    const githubAuth = resolveGitHubCopilotAuth(config, { credentialStore: store });
    const deepSeekAuth = resolveDeepSeekAuth(config, { credentialStore: store });

    return {
      githubCopilot: {
        providerId: 'github-copilot',
        authState: githubAuth.authState,
        credentialSource: githubAuth.credentialSource,
        defaultModelId: githubProvider?.defaultModelId ?? null,
        credentialTarget: config.githubCopilot.credentialTarget?.trim() ?? null,
        oauthClientIdConfigured: Boolean(config.githubCopilot.oauthClientId?.trim()),
      },
      deepseek: {
        providerId: 'deepseek',
        authState: deepSeekAuth.authState,
        credentialSource: deepSeekAuth.credentialSource,
        defaultModelId: deepSeekProvider?.defaultModelId ?? null,
        credentialTarget: config.deepseek.credentialTarget?.trim() ?? null,
        baseUrl: config.deepseek.baseUrl,
      },
    };
  }
}

function createSessionTitle(goal: string): string {
  const trimmed = goal.trim();
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 57)}...`;
}

function shouldRunGitHubCopilotCliSetup(config: AppConfig): boolean {
  const githubProviderEnabled = config.defaultProviderId === 'github-copilot'
    || config.providers.some((provider) => provider.providerId === 'github-copilot' && provider.enabled);

  if (!githubProviderEnabled) {
    return false;
  }

  return resolveGitHubCopilotAuth(config).authState !== 'configured';
}

function registerGitHubCopilotProvider(
  providerRegistry: ProviderRegistry,
  config: AppConfig,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): void {
  const githubCopilotAuth = resolveGitHubCopilotAuth(config, { credentialStore });
  const resolvedToken = resolveGitHubCopilotToken(config, { credentialStore });

  providerRegistry.register(
    createGitHubCopilotProfile(githubCopilotAuth.authState),
    new GitHubCopilotAdapter({
      token: resolvedToken?.token ?? '',
      tokenType: resolvedToken?.tokenType,
      apiUrl: config.githubCopilot.apiUrl,
      exchangeUrl: config.githubCopilot.exchangeUrl,
      userAgent: config.githubCopilot.userAgent,
      editorVersion: config.githubCopilot.editorVersion,
      editorPluginVersion: config.githubCopilot.editorPluginVersion,
      integrationId: config.githubCopilot.integrationId,
    }),
  );
}

function registerDeepSeekProvider(
  providerRegistry: ProviderRegistry,
  config: AppConfig,
  defaultModelId?: string | null,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): void {
  const deepSeekAuth = resolveDeepSeekAuth(config, { credentialStore });
  const resolvedApiKey = resolveDeepSeekApiKey(config, { credentialStore });

  providerRegistry.register(
    createDeepSeekProfile(deepSeekAuth.authState, defaultModelId),
    new DeepSeekAdapter({
      apiKey: resolvedApiKey?.apiKey ?? '',
      baseUrl: config.deepseek.baseUrl,
    }),
  );
}

function createFallbackProviderSetting(
  providerId: string | null,
  githubCredentialSource: ReturnType<typeof resolveGitHubCopilotAuth>['credentialSource'],
  deepseekCredentialSource: ReturnType<typeof resolveDeepSeekAuth>['credentialSource'],
) {
  if (providerId === 'github-copilot') {
    return {
      providerId,
      defaultModelId: 'copilot-chat',
      enabled: true,
      credentialSource: githubCredentialSource,
    };
  }

  if (providerId === 'deepseek') {
    return {
      providerId,
      defaultModelId: 'deepseek-v4-flash',
      enabled: true,
      credentialSource: deepseekCredentialSource,
    };
  }

  return {
    providerId: providerId ?? 'openai',
    defaultModelId: 'gpt-4.1-mini',
    enabled: true,
    credentialSource: 'env' as const,
  };
}

function createTerminalLineReader(): { readLine: (prompt: string) => Promise<string>; close: () => void } {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    readLine(prompt: string): Promise<string> {
      return readline.question(prompt);
    },
    close(): void {
      readline.close();
    },
  };
}

function resolveProjectRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return path.resolve(startDir);
    }

    currentDir = parentDir;
  }
}

function resolveElectronBinary(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronModule = require('electron') as string | { default?: string };

  if (typeof electronModule === 'string' && electronModule.trim()) {
    return electronModule;
  }

  if (typeof electronModule === 'object' && typeof electronModule.default === 'string' && electronModule.default.trim()) {
    return electronModule.default;
  }

  throw new Error('Electron binary path could not be resolved');
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(formatCommandResult(formatError(error)));
    process.exitCode = 1;
  });
}
