export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
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
