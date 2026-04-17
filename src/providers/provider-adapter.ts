export interface ProviderRunRequest {
  readonly modelId: string;
  readonly goal: string;
  readonly inputContextSummary: string;
}

export interface ProviderRunResult {
  readonly outputSummary: string;
}

export interface ProviderAdapter {
  runTask(request: ProviderRunRequest): Promise<ProviderRunResult>;
}

export class InMemoryProviderAdapter implements ProviderAdapter {
  constructor(
    public readonly providerId: string,
    private readonly responseText: string,
  ) {}

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    return {
      outputSummary: `${this.responseText}: ${request.goal}`,
    };
  }
}
