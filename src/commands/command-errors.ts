export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandValidationError';
  }
}

export class SessionCommandError extends CommandValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCommandError';
  }
}
