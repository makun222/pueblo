#!/usr/bin/env node

import type { AppConfig } from '../shared/config';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { createTaskContext } from '../agent/task-context';
import { AgentTaskRepository } from '../agent/task-repository';
import { AgentTaskRunner } from '../agent/task-runner';
import { InputRouter } from '../commands/input-router';
import { createModelCommand } from '../commands/model-command';
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
  createSessionRestoreCommand,
  createSessionSelectCommand,
} from '../commands/session-state-command';
import { CommandDispatcher, createCommandSelectionState, registerCoreCommands } from '../commands/dispatcher';
import { verifyPersistence } from '../persistence/health-check';
import { createSqliteDatabase } from '../persistence/sqlite';
import { GitHubCopilotAdapter } from '../providers/github-copilot-adapter';
import {
  persistGitHubCopilotDeviceAuth,
  pollGitHubDeviceAccessToken,
  requestGitHubDeviceCode,
} from '../providers/github-copilot-device-flow';
import { resolveGitHubCopilotAuth, resolveGitHubCopilotToken } from '../providers/github-copilot-auth';
import { createGitHubCopilotProfile } from '../providers/github-copilot-profile';
import { InMemoryProviderAdapter } from '../providers/provider-adapter';
import { ProviderError } from '../providers/provider-errors';
import { ModelService } from '../providers/model-service';
import { createProviderProfile } from '../providers/provider-profile';
import { ProviderRegistry } from '../providers/provider-registry';
import { loadAppConfig } from '../shared/config';
import { failureResult, formatCommandResult, formatError, successResult } from '../shared/result';
import { MemoryRepository } from '../memory/memory-repository';
import { MemoryService } from '../memory/memory-service';
import { PromptRepository } from '../prompts/prompt-repository';
import { PromptService } from '../prompts/prompt-service';
import { SessionRepository } from '../sessions/session-repository';
import { SessionService } from '../sessions/session-service';
import { ToolInvocationRepository } from '../tools/tool-invocation-repository';
import { ToolService } from '../tools/tool-service';

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
  readonly databaseClose: () => void;
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

interface CliStartupSetupResult {
  readonly performed: boolean;
  readonly configured: boolean;
  readonly config: AppConfig;
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

export async function maybeRunCliStartupSetup(config: AppConfig): Promise<CliStartupSetupResult> {
  if (!shouldRunGitHubCopilotCliSetup(config)) {
    return {
      performed: false,
      configured: true,
      config,
    };
  }

  process.stdout.write('GitHub Copilot is not configured for CLI use. Starting device login flow...\n');

  try {
    const deviceCode = await requestGitHubDeviceCode(config);
    process.stdout.write(`Open ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}\n`);
    process.stdout.write('Waiting for GitHub authorization...\n');

    const token = await pollGitHubDeviceAccessToken(config, deviceCode);
    persistGitHubCopilotDeviceAuth(config, token.accessToken);
    const nextConfig = loadAppConfig();

    process.stdout.write('GitHub Copilot authentication saved to .pueblo/config.json\n');

    return {
      performed: true,
      configured: true,
      config: nextConfig,
    };
  } catch (error) {
    process.stdout.write(formatCommandResult(formatError(error)));

    return {
      performed: true,
      configured: false,
      config,
    };
  }
}

export function createCliDependencies(config: AppConfig = loadAppConfig()): CliDependencies {
  let currentConfig = config;
  const database = createSqliteDatabase({ dbPath: config.databasePath });
  const dispatcher = new CommandDispatcher();
  const selectionState = createCommandSelectionState();
  const providerRegistry = new ProviderRegistry();
  const fallbackProviders = currentConfig.providers.length > 0
    ? currentConfig.providers
    : [{ providerId: currentConfig.defaultProviderId ?? 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }];
  const githubCopilotAuth = resolveGitHubCopilotAuth(currentConfig);
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
      registerGitHubCopilotProvider(providerRegistry, currentConfig);
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
  const promptService = new PromptService(promptRepository);
  const memoryService = new MemoryService(memoryRepository);
  const selectedPromptIds = new Set<string>();
  const selectedMemoryIds = new Set<string>();
  const toolInvocationRepository = new ToolInvocationRepository({ connection: database.connection });
  const toolService = new ToolService({ repository: toolInvocationRepository, cwd: process.cwd() });
  const taskRunner = new AgentTaskRunner(providerRegistry, taskRepository, toolService);
  const sessionRepository = new SessionRepository({ connection: database.connection });
  const sessionService = new SessionService(sessionRepository);

  const runTask = async (goal: string, inputContextSummary: string) => {
    const trimmedGoal = goal.trim();

    if (!trimmedGoal) {
      return failureResult('TASK_GOAL_REQUIRED', 'Task goal is required', ['Provide a task goal and retry.']);
    }

    const providerId = selectionState.providerId
      ?? currentConfig.defaultProviderId
      ?? providerRegistry.listProfiles().find((profile) => profile.authState === 'configured')?.id
      ?? providerRegistry.listProfiles()[0]?.id
      ?? null;
    const selectedProfile = providerId
      ? providerRegistry.listProfiles().find((profile) => profile.id === providerId) ?? null
      : null;
    const modelId = selectionState.modelId ?? selectedProfile?.defaultModelId ?? null;

    if (!providerId || !modelId) {
      return failureResult('MODEL_SELECTION_REQUIRED', 'Select a provider model before running a task', [
        'Use /model to choose a provider and model.',
      ]);
    }

    try {
      const task = await taskRunner.run({
        goal: trimmedGoal,
        sessionId: selectionState.sessionId ?? currentConfig.defaultSessionId,
        providerId,
        modelId,
        inputContextSummary,
        prompts: [...selectedPromptIds].map((promptId) => promptService.selectPrompt(promptId)),
        memories: [...selectedMemoryIds].map((memoryId) => memoryService.selectMemory(memoryId)),
      });

      return successResult('TASK_COMPLETED', 'Agent task completed', task);
    } catch (error) {
      if (error instanceof ProviderError) {
        return failureResult('TASK_RUN_FAILED', error.message, [
          'Use /model to review the active provider configuration.',
          'Use /auth-login to sign in to GitHub Copilot when credentials are missing.',
        ]);
      }

      throw error;
    }
  };
  const inputRouter = new InputRouter({
    dispatcher,
    runTaskFromText: (text) => runTask(text, 'Plain-text task execution'),
  });

  registerCoreCommands(dispatcher);
  const handleCurrentSessionChange = (sessionId: string | null): void => {
    selectionState.sessionId = sessionId;

    if (!sessionId) {
      return;
    }

    const session = sessionService.getCurrentSession();
    if (session?.currentModelId) {
      selectionState.modelId = session.currentModelId;
    }
  };

  dispatcher.register('/new', createNewSessionCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-list', createSessionListCommand({ sessionService }));
  dispatcher.register('/session-sel', createSessionSelectCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-archive', createSessionArchiveCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-restore', createSessionRestoreCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/session-del', createSessionDeleteCommand({ sessionService, onCurrentSessionChange: handleCurrentSessionChange }));
  dispatcher.register('/prompt-list', createPromptListCommand({ promptService, selectedPromptIds }));
  dispatcher.register('/prompt-add', createPromptAddCommand({ promptService, selectedPromptIds }));
  dispatcher.register('/prompt-sel', createPromptSelectCommand({ promptService, selectedPromptIds }));
  dispatcher.register('/prompt-del', createPromptDeleteCommand({ promptService, selectedPromptIds }));
  dispatcher.register('/memory-list', createMemoryListCommand({ memoryService, selectedMemoryIds }));
  dispatcher.register('/memory-add', createMemoryAddCommand({ memoryService, selectedMemoryIds }));
  dispatcher.register('/memory-sel', createMemorySelectCommand({ memoryService, selectedMemoryIds }));
  dispatcher.register('/memory-search', createMemorySearchCommand({ memoryService, selectedMemoryIds }));
  dispatcher.register('/auth-login', async () => {
    const setup = await maybeRunCliStartupSetup(currentConfig);

    if (!setup.performed) {
      return successResult('AUTH_ALREADY_CONFIGURED', 'GitHub Copilot is already configured');
    }

    if (!setup.configured) {
      return failureResult('AUTH_LOGIN_FAILED', 'GitHub Copilot login was not completed', [
        'Check githubCopilot.oauthClientId and network access, then retry.',
      ]);
    }

    currentConfig = setup.config;
    registerGitHubCopilotProvider(providerRegistry, currentConfig);

    return successResult('AUTH_LOGIN_COMPLETED', 'GitHub Copilot login completed');
  });
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
  const currentSession = sessionService.getCurrentSession();
  selectionState.sessionId = currentSession?.id ?? currentConfig.defaultSessionId;
  selectionState.providerId = currentConfig.defaultProviderId;
  selectionState.modelId = currentSession?.currentModelId ?? null;
  createTaskContext({
    config: currentConfig,
    session: currentSession,
    currentSessionId: selectionState.sessionId,
  });

  return {
    dispatcher,
    submitInput(input: string) {
      return inputRouter.route(input);
    },
    databaseClose(): void {
      database.close();
    },
  };
}

function shouldRunGitHubCopilotCliSetup(config: AppConfig): boolean {
  const githubProviderEnabled = config.defaultProviderId === 'github-copilot'
    || config.providers.some((provider) => provider.providerId === 'github-copilot' && provider.enabled);

  if (!githubProviderEnabled) {
    return false;
  }

  return resolveGitHubCopilotAuth(config).authState !== 'configured';
}

function registerGitHubCopilotProvider(providerRegistry: ProviderRegistry, config: AppConfig): void {
  const githubCopilotAuth = resolveGitHubCopilotAuth(config);
  const resolvedToken = resolveGitHubCopilotToken(config);

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
