import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { tokenizeCommandInput } from '../../commands/dispatcher';
import {
  createOutputBlock,
  extractTaskOutputSummaryText,
  failureResult,
  successResult,
  type CommandResult,
} from '../../shared/result';
import type { IpcInputEnvelope, RendererOutputBlock } from '../../shared/schema';
import type { DesktopRuntimeStatus } from '../shared/ipc-contract';
import type {
  DesktopTalkActiveConversation,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
} from '../shared/ipc-contract';

const REGISTRY_DIRECTORY = path.join(os.tmpdir(), 'pueblo-talk-registry');
const TALK_HOST = '127.0.0.1';
const DEFAULT_TALK_TURNS_LIMIT = 50;

type TalkDecision = 'pending' | 'approved' | 'rejected';

type TalkFrame =
  | {
    readonly type: 'request';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly fromAgentProfileName: string | null;
    readonly message: string;
    readonly createdAt: string;
  }
  | {
    readonly type: 'accept';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly fromAgentProfileName: string | null;
  }
  | {
    readonly type: 'reject';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly reason: string;
  }
  | {
    readonly type: 'turn';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly text: string;
    readonly turnCount: number;
    readonly requiresContinuation: boolean;
  }
  | {
    readonly type: 'continue-decision';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly decision: 'approved' | 'rejected';
    readonly roundCount: number;
  }
  | {
    readonly type: 'end';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly reason: string;
  }
  | {
    readonly type: 'error';
    readonly conversationId: string;
    readonly fromPid: number;
    readonly message: string;
  };

interface PendingIncomingRequest {
  readonly conversationId: string;
  readonly fromPid: number;
  readonly fromAgentProfileName: string | null;
  readonly message: string;
  readonly createdAt: string;
  readonly socket: WebSocket;
}

interface InternalContinuationState {
  readonly roundCount: number;
  readonly turnLimit: number;
  localDecision: TalkDecision;
  remoteDecision: TalkDecision;
  deferredPeerTurnText: string | null;
}

interface InternalConversationState {
  readonly conversationId: string;
  readonly peerPid: number;
  peerAgentProfileName: string | null;
  readonly initiatedBy: 'local' | 'remote';
  status: 'requesting' | 'active';
  turnCount: number;
  readonly turnLimit: number;
  readonly socket: WebSocket;
  continuation: InternalContinuationState | null;
}

interface RegistryEntry {
  readonly pid: number;
  readonly port: number;
  readonly updatedAt: string;
}

export interface DesktopTalkServiceDependencies {
  readonly getRuntimeStatus: () => DesktopRuntimeStatus;
  readonly executeInput: (envelope: IpcInputEnvelope) => Promise<{
    readonly result: CommandResult<unknown>;
    readonly blocks: RendererOutputBlock[];
    readonly runtimeStatus: DesktopRuntimeStatus;
  }>;
  readonly publishOutput: (block: RendererOutputBlock) => void;
}

export interface DesktopTalkServiceOptions {
  readonly localPid?: number;
  readonly registryDirectory?: string;
  readonly host?: string;
  readonly turnLimit?: number;
}

export class DesktopTalkService {
  private readonly listeners = new Set<(state: DesktopTalkState) => void>();
  private readonly server: WebSocketServer;
  private readonly readyPromise: Promise<void>;
  private readonly localPid: number;
  private readonly registryDirectory: string;
  private readonly host: string;
  private readonly turnLimit: number;
  private pendingIncomingRequest: PendingIncomingRequest | null = null;
  private activeConversation: InternalConversationState | null = null;
  private readonly frameQueues = new WeakMap<WebSocket, Promise<void>>();

  constructor(
    private readonly dependencies: DesktopTalkServiceDependencies,
    options: DesktopTalkServiceOptions = {},
  ) {
    this.localPid = options.localPid ?? process.pid;
    this.registryDirectory = options.registryDirectory ?? REGISTRY_DIRECTORY;
    this.host = options.host ?? TALK_HOST;
    this.turnLimit = options.turnLimit ?? DEFAULT_TALK_TURNS_LIMIT;

    fs.mkdirSync(this.registryDirectory, { recursive: true });
    this.server = new WebSocketServer({ host: this.host, port: 0 });
    this.readyPromise = new Promise((resolve, reject) => {
      this.server.once('listening', () => {
        this.writeRegistryEntry();
        resolve();
      });
      this.server.once('error', reject);
    });

    this.server.on('connection', (socket) => {
      this.bindSocket(socket);
    });
  }

  onStateChange(listener: (state: DesktopTalkState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): DesktopTalkState {
    return {
      localPid: this.localPid,
      incomingRequest: this.pendingIncomingRequest
        ? {
          conversationId: this.pendingIncomingRequest.conversationId,
          fromPid: this.pendingIncomingRequest.fromPid,
          fromAgentProfileName: this.pendingIncomingRequest.fromAgentProfileName,
          message: this.pendingIncomingRequest.message,
          createdAt: this.pendingIncomingRequest.createdAt,
        }
        : null,
      activeConversation: this.toPublicConversation(this.activeConversation),
    };
  }

  async handleTalkCommand(inputText: string): Promise<CommandResult<unknown> | null> {
    const tokens = tokenizeCommandInput(inputText);
    if (tokens[0] !== '/talkto') {
      return null;
    }

    const [rawPid, actionOrFlag, ...rest] = tokens.slice(1);
    const peerPid = Number.parseInt(rawPid ?? '', 10);

    if (!Number.isInteger(peerPid) || peerPid <= 0) {
      return failureResult('TALK_PID_REQUIRED', 'Use /talkto <pid> -m "message" or /talkto <pid> end.', [
        'Provide the peer desktop process id.',
      ]);
    }

    if (peerPid === this.localPid) {
      return failureResult('TALK_SELF_NOT_ALLOWED', 'You cannot start a talk session with the current process.', [
        'Choose another desktop process id.',
      ]);
    }

    if (actionOrFlag === 'end') {
      if (!this.activeConversation) {
        return failureResult('TALK_NOT_ACTIVE', 'No active talk session is running.', [
          'Start a talk session with /talkto <pid> -m "message".',
        ]);
      }

      if (this.activeConversation.peerPid !== peerPid) {
        return failureResult(
          'TALK_PID_MISMATCH',
          `Current talk session is with pid ${this.activeConversation.peerPid}.`,
          [`Use /talkto ${this.activeConversation.peerPid} end to stop the active talk session.`],
        );
      }

      await this.endConversation('Ended by local user.', true);
      return successResult('TALK_ENDED', 'Talk session ended.', {
        outputSummary: `Talk session with pid ${peerPid} ended.`,
      });
    }

    if (this.pendingIncomingRequest || this.activeConversation) {
      return failureResult(
        'TALK_BUSY',
        this.activeConversation
          ? `A talk session with pid ${this.activeConversation.peerPid} is already active.`
          : `A talk request from pid ${this.pendingIncomingRequest?.fromPid ?? 'unknown'} is waiting for a decision.`,
        [
          this.activeConversation
            ? `Use /talkto ${this.activeConversation.peerPid} end before starting another talk session.`
            : 'Accept or reject the pending talk request first.',
        ],
      );
    }

    if (actionOrFlag !== '-m') {
      return failureResult('TALK_MESSAGE_REQUIRED', 'Use /talkto <pid> -m "message" to start a talk session.', [
        'Add -m followed by the first user message for the peer agent.',
      ]);
    }

    const message = rest.join(' ').trim();
    if (!message) {
      return failureResult('TALK_MESSAGE_REQUIRED', 'The initial talk message cannot be empty.', [
        'Provide a non-empty message after -m.',
      ]);
    }

    return this.startOutgoingConversation(peerPid, message);
  }

  canAcceptUserInput(): boolean {
    return this.activeConversation === null;
  }

  createLockedResult(): CommandResult<unknown> {
    if (!this.activeConversation) {
      return failureResult('TALK_NOT_ACTIVE', 'No active talk session is running.');
    }

    return failureResult(
      'TALK_INPUT_LOCKED',
      `A talk session with pid ${this.activeConversation.peerPid} is active.`,
      [`Only /talkto ${this.activeConversation.peerPid} end is accepted while the talk session is running.`],
    );
  }

  async respondToIncomingRequest(response: DesktopTalkRequestResponse): Promise<DesktopTalkState> {
    const pendingRequest = this.pendingIncomingRequest;
    if (!pendingRequest || pendingRequest.conversationId !== response.conversationId) {
      throw new Error('Talk request is no longer pending.');
    }

    this.pendingIncomingRequest = null;

    if (response.decision === 'reject') {
      await this.sendFrame(pendingRequest.socket, {
        type: 'reject',
        conversationId: pendingRequest.conversationId,
        fromPid: this.localPid,
        reason: 'Rejected by the local user.',
      });
      pendingRequest.socket.close();
      this.publishSystemMessage('Talk Request', `Rejected talk request from pid ${pendingRequest.fromPid}.`);
      this.emitState();
      return this.getState();
    }

    this.activeConversation = {
      conversationId: pendingRequest.conversationId,
      peerPid: pendingRequest.fromPid,
      peerAgentProfileName: pendingRequest.fromAgentProfileName,
      initiatedBy: 'remote',
      status: 'active',
      turnCount: 0,
      turnLimit: this.turnLimit,
      socket: pendingRequest.socket,
      continuation: null,
    };
    this.emitState();
    await this.sendFrame(pendingRequest.socket, {
      type: 'accept',
      conversationId: pendingRequest.conversationId,
      fromPid: this.localPid,
      fromAgentProfileName: this.dependencies.getRuntimeStatus().agentProfileName ?? null,
    });
    this.publishSystemMessage('Talk Started', `Accepted talk request from pid ${pendingRequest.fromPid}.`);
    void this.processLocalTurn(pendingRequest.message, 0);
    return this.getState();
  }

  async respondToContinuation(response: DesktopTalkContinuationResponse): Promise<DesktopTalkState> {
    const conversation = this.activeConversation;
    if (!conversation || conversation.conversationId !== response.conversationId || !conversation.continuation) {
      throw new Error('No talk continuation prompt is pending.');
    }

    if (response.decision === 'end') {
      conversation.continuation.localDecision = 'rejected';
      this.emitState();
      await this.sendFrame(conversation.socket, {
        type: 'continue-decision',
        conversationId: conversation.conversationId,
        fromPid: this.localPid,
        decision: 'rejected',
        roundCount: conversation.continuation.roundCount,
      });
      await this.endConversation('Talk session ended after the turn limit confirmation.', false);
      return this.getState();
    }

    conversation.continuation.localDecision = 'approved';
    this.emitState();
    await this.sendFrame(conversation.socket, {
      type: 'continue-decision',
      conversationId: conversation.conversationId,
      fromPid: this.localPid,
      decision: 'approved',
      roundCount: conversation.continuation.roundCount,
    });
    await this.resumeConversationIfReady(conversation);
    return this.getState();
  }

  async dispose(): Promise<void> {
    await this.endConversation('Desktop window closed.', false);
    this.pendingIncomingRequest?.socket.close();
    this.pendingIncomingRequest = null;
    this.removeRegistryEntry();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async startOutgoingConversation(peerPid: number, message: string): Promise<CommandResult<unknown>> {
    try {
      await this.readyPromise;
      const registryEntry = this.readRegistryEntry(peerPid);
      const socket = await this.openClientSocket(registryEntry.port);
      this.bindSocket(socket);

      const conversationId = `${new Date().toISOString()}-talk-${Math.random().toString(16).slice(2)}`;
      this.activeConversation = {
        conversationId,
        peerPid,
        peerAgentProfileName: null,
        initiatedBy: 'local',
        status: 'requesting',
        turnCount: 0,
        turnLimit: this.turnLimit,
        socket,
        continuation: null,
      };
      this.emitState();

      await this.sendFrame(socket, {
        type: 'request',
        conversationId,
        fromPid: this.localPid,
        fromAgentProfileName: this.dependencies.getRuntimeStatus().agentProfileName ?? null,
        message,
        createdAt: new Date().toISOString(),
      });
      this.publishSystemMessage('Talk Request', `Sent talk request to pid ${peerPid}.`);

      return successResult('TALK_REQUESTED', 'Talk request sent.', {
        outputSummary: `Talk request sent to pid ${peerPid}. Waiting for the peer to accept or reject it.`,
      });
    } catch (error) {
      this.activeConversation?.socket.close();
      this.activeConversation = null;
      this.emitState();
      return failureResult(
        'TALK_START_FAILED',
        error instanceof Error ? error.message : 'Failed to start the talk session.',
        ['Verify that the peer desktop process is running and retry.'],
      );
    }
  }

  private bindSocket(socket: WebSocket): void {
    socket.on('message', (payload) => {
      const queued = this.frameQueues.get(socket) ?? Promise.resolve();
      const nextQueue = queued
        .catch(() => {})
        .then(async () => {
          const frame = this.parseFrame(payload.toString());
          if (!frame) {
            return;
          }

          await this.handleFrame(socket, frame);
        });
      this.frameQueues.set(socket, nextQueue);
    });

    socket.on('close', () => {
      this.handleSocketClosed(socket);
    });
  }

  private async handleFrame(socket: WebSocket, frame: TalkFrame): Promise<void> {
    switch (frame.type) {
      case 'request': {
        if (this.pendingIncomingRequest || this.activeConversation) {
          await this.sendFrame(socket, {
            type: 'reject',
            conversationId: frame.conversationId,
            fromPid: this.localPid,
            reason: this.activeConversation
              ? `Already talking to pid ${this.activeConversation.peerPid}.`
              : 'Another talk request is already pending.',
          });
          socket.close();
          return;
        }

        this.pendingIncomingRequest = {
          conversationId: frame.conversationId,
          fromPid: frame.fromPid,
          fromAgentProfileName: frame.fromAgentProfileName,
          message: frame.message,
          createdAt: frame.createdAt,
          socket,
        };
        this.publishSystemMessage('Talk Request', `Incoming talk request from pid ${frame.fromPid}.`);
        this.emitState();
        return;
      }

      case 'accept': {
        if (!this.activeConversation || this.activeConversation.conversationId !== frame.conversationId) {
          return;
        }

        this.activeConversation.status = 'active';
        this.activeConversation.peerAgentProfileName = frame.fromAgentProfileName;
        this.emitState();
        this.publishSystemMessage('Talk Started', `Talk request accepted by pid ${frame.fromPid}.`);
        return;
      }

      case 'reject': {
        if (!this.activeConversation || this.activeConversation.conversationId !== frame.conversationId) {
          return;
        }

        this.publishSystemMessage('Talk Request', `Talk request rejected by pid ${frame.fromPid}: ${frame.reason}`);
        await this.endConversation(`Talk request rejected by pid ${frame.fromPid}.`, false);
        return;
      }

      case 'turn': {
        const conversation = this.activeConversation;
        if (!conversation || conversation.conversationId !== frame.conversationId) {
          return;
        }

        conversation.turnCount = Math.max(conversation.turnCount, frame.turnCount);
        if (frame.requiresContinuation) {
          conversation.continuation = {
            roundCount: frame.turnCount,
            turnLimit: conversation.turnLimit,
            localDecision: 'pending',
            remoteDecision: 'pending',
            deferredPeerTurnText: frame.text,
          };
          this.publishSystemMessage('Talk Pause', `Turn limit reached at ${frame.turnCount} turns. Waiting for both sides to continue.`);
          this.emitState();
          return;
        }

        if (conversation.continuation) {
          conversation.continuation.deferredPeerTurnText = frame.text;
          this.emitState();
          return;
        }

        void this.processLocalTurn(frame.text, frame.turnCount);
        return;
      }

      case 'continue-decision': {
        const conversation = this.activeConversation;
        if (!conversation || conversation.conversationId !== frame.conversationId || !conversation.continuation) {
          return;
        }

        if (frame.decision === 'rejected') {
          this.publishSystemMessage('Talk Ended', `Peer pid ${frame.fromPid} chose not to continue after ${frame.roundCount} turns.`);
          await this.endConversation('Peer ended the talk session after the turn limit confirmation.', false);
          return;
        }

        conversation.continuation.remoteDecision = 'approved';
        this.emitState();
        await this.resumeConversationIfReady(conversation);
        return;
      }

      case 'end': {
        const conversation = this.activeConversation;
        if (!conversation || conversation.conversationId !== frame.conversationId) {
          return;
        }

        this.publishSystemMessage('Talk Ended', `Peer pid ${frame.fromPid} ended the talk session: ${frame.reason}`);
        await this.endConversation(frame.reason, false);
        return;
      }

      case 'error': {
        this.publishSystemMessage('Talk Error', `Peer pid ${frame.fromPid}: ${frame.message}`);
        await this.endConversation(frame.message, false);
        return;
      }
    }
  }

  private async processLocalTurn(peerText: string, receivedTurnCount: number): Promise<void> {
    const conversation = this.activeConversation;
    if (!conversation || conversation.status !== 'active') {
      return;
    }

    this.publishSystemMessage('Talk Turn', `Peer ${conversation.peerPid}: ${peerText}`);

    try {
      const response = await this.dependencies.executeInput(this.createTalkEnvelope(peerText));
      if (this.activeConversation !== conversation) {
        return;
      }

      if (!response.result.ok) {
        await this.sendFrame(conversation.socket, {
          type: 'error',
          conversationId: conversation.conversationId,
          fromPid: this.localPid,
          message: response.result.message,
        });
        await this.endConversation(`Talk turn failed: ${response.result.message}`, false);
        return;
      }

      const assistantText = this.extractAssistantText(response.result);
      if (!assistantText) {
        await this.sendFrame(conversation.socket, {
          type: 'error',
          conversationId: conversation.conversationId,
          fromPid: this.localPid,
          message: 'No assistant response was produced for the talk turn.',
        });
        await this.endConversation('Talk turn finished without an assistant response.', false);
        return;
      }

      const nextTurnCount = Math.max(conversation.turnCount, receivedTurnCount) + 1;
      conversation.turnCount = nextTurnCount;
      const requiresContinuation = nextTurnCount % conversation.turnLimit === 0;
      if (requiresContinuation) {
        conversation.continuation = {
          roundCount: nextTurnCount,
          turnLimit: conversation.turnLimit,
          localDecision: 'pending',
          remoteDecision: 'pending',
          deferredPeerTurnText: null,
        };
      }
      this.emitState();

      await this.sendFrame(conversation.socket, {
        type: 'turn',
        conversationId: conversation.conversationId,
        fromPid: this.localPid,
        text: assistantText,
        turnCount: nextTurnCount,
        requiresContinuation,
      });
      if (requiresContinuation) {
        this.publishSystemMessage('Talk Pause', `Reached ${nextTurnCount} talk turns. Waiting for both sides to continue.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to process the talk turn.';
      if (this.activeConversation === conversation) {
        await this.sendFrame(conversation.socket, {
          type: 'error',
          conversationId: conversation.conversationId,
          fromPid: this.localPid,
          message,
        }).catch(() => {});
      }
      await this.endConversation(message, false);
    }
  }

  private async resumeConversationIfReady(conversation: InternalConversationState): Promise<void> {
    if (this.activeConversation !== conversation || !conversation.continuation) {
      return;
    }

    if (conversation.continuation.localDecision !== 'approved' || conversation.continuation.remoteDecision !== 'approved') {
      return;
    }

    const deferredPeerTurnText = conversation.continuation.deferredPeerTurnText;
    conversation.continuation = null;
    this.emitState();

    if (deferredPeerTurnText) {
      void this.processLocalTurn(deferredPeerTurnText, conversation.turnCount);
    }
  }

  private async endConversation(reason: string, notifyPeer: boolean): Promise<void> {
    const conversation = this.activeConversation;
    this.activeConversation = null;
    this.emitState();

    if (!conversation) {
      return;
    }

    if (notifyPeer && conversation.socket.readyState === WebSocket.OPEN) {
      await this.sendFrame(conversation.socket, {
        type: 'end',
        conversationId: conversation.conversationId,
        fromPid: this.localPid,
        reason,
      }).catch(() => {});
    }

    conversation.socket.close();
    this.publishSystemMessage('Talk Ended', reason);
  }

  private handleSocketClosed(socket: WebSocket): void {
    if (this.pendingIncomingRequest?.socket === socket) {
      this.pendingIncomingRequest = null;
      this.emitState();
    }

    if (this.activeConversation?.socket === socket) {
      const reason = this.activeConversation.status === 'requesting'
        ? 'Peer connection closed before the talk request was resolved.'
        : 'Peer connection closed.';
      this.activeConversation = null;
      this.emitState();
      this.publishSystemMessage('Talk Ended', reason);
    }
  }

  private createTalkEnvelope(inputText: string): IpcInputEnvelope {
    const submittedAt = new Date().toISOString();
    return {
      requestId: `${submittedAt}-${Math.random().toString(16).slice(2)}`,
      windowId: 'desktop-window',
      sessionId: this.dependencies.getRuntimeStatus().activeSessionId ?? null,
      inputText,
      attachments: [],
      submittedAt,
    };
  }

  private extractAssistantText(result: CommandResult<unknown>): string | null {
    if (!result.data || typeof result.data !== 'object') {
      return result.message.trim() || null;
    }

    const outputSummary = (result.data as { outputSummary?: string }).outputSummary;
    return extractTaskOutputSummaryText(outputSummary)?.trim() || result.message.trim() || null;
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private publishSystemMessage(title: string, content: string): void {
    this.dependencies.publishOutput(createOutputBlock({
      type: 'system',
      title,
      content,
      sourceRefs: [],
    }));
  }

  private toPublicConversation(conversation: InternalConversationState | null): DesktopTalkActiveConversation | null {
    if (!conversation) {
      return null;
    }

    return {
      conversationId: conversation.conversationId,
      peerPid: conversation.peerPid,
      peerAgentProfileName: conversation.peerAgentProfileName,
      initiatedBy: conversation.initiatedBy,
      status: conversation.status,
      turnCount: conversation.turnCount,
      turnLimit: conversation.turnLimit,
      continuationPrompt: conversation.continuation
        ? {
          roundCount: conversation.continuation.roundCount,
          turnLimit: conversation.continuation.turnLimit,
          localDecision: conversation.continuation.localDecision,
          remoteDecision: conversation.continuation.remoteDecision,
        }
        : null,
    };
  }

  private async openClientSocket(port: number): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${port}`);
      const handleError = (error: Error) => {
        socket.off('open', handleOpen);
        reject(error);
      };
      const handleOpen = () => {
        socket.off('error', handleError);
        resolve(socket);
      };

      socket.once('error', handleError);
      socket.once('open', handleOpen);
    });
  }

  private parseFrame(payload: string): TalkFrame | null {
    try {
      return JSON.parse(payload) as TalkFrame;
    } catch {
      return null;
    }
  }

  private async sendFrame(socket: WebSocket, frame: TalkFrame): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('Peer connection is not open.');
    }

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(frame), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private writeRegistryEntry(): void {
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      return;
    }

    const entry: RegistryEntry = {
      pid: this.localPid,
      port: address.port,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(this.resolveRegistryPath(this.localPid), JSON.stringify(entry, null, 2), 'utf8');
  }

  private readRegistryEntry(peerPid: number): RegistryEntry {
    const registryPath = this.resolveRegistryPath(peerPid);
    if (!fs.existsSync(registryPath)) {
      throw new Error(`No desktop talk registry entry was found for pid ${peerPid}.`);
    }

    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as RegistryEntry;
  }

  private removeRegistryEntry(): void {
    fs.rmSync(this.resolveRegistryPath(this.localPid), { force: true });
  }

  private resolveRegistryPath(pid: number): string {
    return path.join(this.registryDirectory, `${pid}.json`);
  }
}