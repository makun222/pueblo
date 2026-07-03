// ---------------------------------------------------------------------------
// Channel Errors — Error hierarchy mirroring provider-errors.ts
// ---------------------------------------------------------------------------

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

export class ChannelNotFoundError extends ChannelError {
  readonly kind: string;

  constructor(kind: string) {
    super(`Channel not found: ${kind}`);
    this.name = 'ChannelNotFoundError';
    this.kind = kind;
  }
}

export class ChannelAuthError extends ChannelError {
  readonly channelId: string;

  constructor(channelId: string, message = 'Channel credentials are not ready') {
    super(`${channelId}: ${message}`);
    this.name = 'ChannelAuthError';
    this.channelId = channelId;
  }
}

export class ChannelUnavailableError extends ChannelError {
  readonly channelId: string;

  constructor(channelId: string) {
    super(`Channel is not available: ${channelId}`);
    this.name = 'ChannelUnavailableError';
    this.channelId = channelId;
  }
}

export class ChannelConnectionError extends ChannelError {
  readonly channelId: string;

  constructor(channelId: string, detail: string) {
    super(`Channel "${channelId}" connection error: ${detail}`);
    this.name = 'ChannelConnectionError';
    this.channelId = channelId;
  }
}
