const DEFAULT_TASK_CANCELLATION_MESSAGE = 'Task cancelled.';

export class TaskCancellationError extends Error {
  constructor(message = DEFAULT_TASK_CANCELLATION_MESSAGE) {
    super(message);
    this.name = 'TaskCancellationError';
  }
}

export function createTaskCancellationError(message = DEFAULT_TASK_CANCELLATION_MESSAGE): TaskCancellationError {
  return new TaskCancellationError(message);
}

export function isAbortSignalError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isTaskCancellationError(error: unknown): boolean {
  return error instanceof TaskCancellationError || isAbortSignalError(error);
}

export function resolveTaskCancellationMessage(signal: AbortSignal | undefined, fallbackMessage = DEFAULT_TASK_CANCELLATION_MESSAGE): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }

  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }

  return fallbackMessage;
}

export function throwIfTaskCancelled(signal: AbortSignal | undefined, fallbackMessage = DEFAULT_TASK_CANCELLATION_MESSAGE): void {
  if (!signal?.aborted) {
    return;
  }

  throw new TaskCancellationError(resolveTaskCancellationMessage(signal, fallbackMessage));
}

export function toTaskCancellationError(error: unknown, fallbackMessage = DEFAULT_TASK_CANCELLATION_MESSAGE): TaskCancellationError {
  if (error instanceof TaskCancellationError) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return new TaskCancellationError(error.message);
  }

  return new TaskCancellationError(fallbackMessage);
}