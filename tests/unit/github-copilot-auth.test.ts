import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitHubCopilotAuth, resolveGitHubCopilotToken } from '../../src/providers/github-copilot-auth';
import { createTestAppConfig } from '../helpers/test-config';

const previousEnvToken = process.env.GITHUB_COPILOT_TOKEN;

afterEach(() => {
  if (previousEnvToken === undefined) {
    delete process.env.GITHUB_COPILOT_TOKEN;
    return;
  }

  process.env.GITHUB_COPILOT_TOKEN = previousEnvToken;
});

describe('github copilot auth', () => {
  it('infers github auth token type from gho prefix', () => {
    const config = createTestAppConfig({
      githubCopilot: {
        token: 'gho_example_token',
      },
    });

    const resolved = resolveGitHubCopilotToken(config);

    expect(resolved).toEqual({
      token: 'gho_example_token',
      tokenType: 'github-auth-token',
    });
  });

  it('falls back to environment token when config token is missing', () => {
    process.env.GITHUB_COPILOT_TOKEN = 'copilot_access_token';
    const config = createTestAppConfig({
      githubCopilot: {
        token: undefined,
      },
    });

    const resolved = resolveGitHubCopilotToken(config);

    expect(resolved).toEqual({
      token: 'copilot_access_token',
      tokenType: 'copilot-access-token',
    });
  });

  it('marks personal access tokens as invalid auth state', () => {
    const config = createTestAppConfig({
      providers: [
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: 'config-file',
        },
      ],
      githubCopilot: {
        token: 'ghp_example_pat',
      },
    });

    const status = resolveGitHubCopilotAuth(config);

    expect(status).toEqual({
      providerId: 'github-copilot',
      authState: 'invalid',
      credentialSource: 'config-file',
    });
  });

  it('defaults credentialSource to env when provider settings are absent', () => {
    const config = createTestAppConfig({
      providers: [],
      githubCopilot: {
        token: undefined,
      },
    });

    const status = resolveGitHubCopilotAuth(config);

    expect(status).toEqual({
      providerId: 'github-copilot',
      authState: 'missing',
      credentialSource: 'env',
    });
  });
});