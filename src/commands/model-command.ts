import { failureResult, successResult, type CommandResult } from '../shared/result';
import { ModelService } from '../providers/model-service';
import { ProviderError } from '../providers/provider-errors';

export interface ModelCommandDependencies {
  readonly modelService: ModelService;
  readonly getCurrentSessionId: () => string | null;
  readonly setCurrentSessionModel: (sessionId: string, modelId: string) => void;
  setSelection(providerId: string, modelId: string): void;
}

export function createModelCommand(dependencies: ModelCommandDependencies) {
  return (args: string[]): CommandResult => {
    try {
      if (args.length === 0) {
        const models = dependencies.modelService.listModels();

        return successResult('MODEL_LIST', 'Available models', {
          models,
        });
      }

      const [providerId, modelId] = args;
      const selection = dependencies.modelService.selectModel(providerId, modelId);
      dependencies.setSelection(selection.provider.id, selection.model.id);
      const currentSessionId = dependencies.getCurrentSessionId();

      if (currentSessionId) {
        dependencies.setCurrentSessionModel(currentSessionId, selection.model.id);
      }

      return successResult('MODEL_SELECTED', 'Current model updated', {
        providerId: selection.provider.id,
        modelId: selection.model.id,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        return failureResult('MODEL_SELECTION_FAILED', error.message, [
          'Use /model to list available providers and models.',
        ]);
      }

      throw error;
    }
  };
}
