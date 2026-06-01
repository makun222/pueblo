import type { ProviderRequestMetrics } from './provider-adapter';

export class ProviderError extends Error {
  readonly requestMetrics?: ProviderRequestMetrics;

  constructor(message: string, options: { readonly requestMetrics?: ProviderRequestMetrics } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.requestMetrics = options.requestMetrics;
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(providerId: string) {
    super(`Provider not found: ${providerId}`);
    this.name = 'ProviderNotFoundError';
  }
}

export class ModelNotFoundError extends ProviderError {
  constructor(providerId: string, modelId: string) {
    super(`Model not found for provider ${providerId}: ${modelId}`);
    this.name = 'ModelNotFoundError';
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(providerId: string) {
    super(`Provider is not available: ${providerId}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(providerId: string, message = 'Provider credentials are not ready') {
    super(`${providerId}: ${message}`);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderUnknownToolError extends ProviderError {
  readonly providerId: string;
  readonly requestedToolName: string;

  constructor(providerId: string, requestedToolName: string) {
    super(`${providerId}: requested unavailable tool "${requestedToolName}"`);
    this.name = 'ProviderUnknownToolError';
    this.providerId = providerId;
    this.requestedToolName = requestedToolName;
  }
}

export interface ProviderToolValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ProviderInvalidToolArgumentsError extends ProviderError {
  readonly providerId: string;
  readonly toolName: string;
  readonly issues: readonly ProviderToolValidationIssue[];

  constructor(providerId: string, toolName: string, issues: readonly ProviderToolValidationIssue[]) {
    super(`${providerId}: invalid arguments for tool "${toolName}"`);
    this.name = 'ProviderInvalidToolArgumentsError';
    this.providerId = providerId;
    this.toolName = toolName;
    this.issues = issues;
  }
}
