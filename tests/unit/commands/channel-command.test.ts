import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChannelCommand, type ChannelService } from '../../../src/channel/channel-service';
import type { ChannelConfig, ChannelType } from '../../../src/channel/channel-types';
import { InMemoryChannelAdapter } from '../../../src/channel/channel-adapter';
import { createChannelRegistry } from '../../../src/channel/channel-registry-factory';

// ---------------------------------------------------------------------------
// Mock Command (lightweight)
// ---------------------------------------------------------------------------
interface MockCommand {
  name: string;
  description: string;
  action: (...args: any[]) => any;
  subcommands: MockCommand[];
  option: (flags: string, desc?: string) => MockCommand;
  command: (name: string, desc?: string) => MockCommand;
  opts: Record<string, any>;
}

function mockCommanderGroup(name: string): MockCommand {
  const cmd: MockCommand = {
    name,
    description: '',
    action: vi.fn(),
    subcommands: [],
    opts: {},
    option(flags: string, desc?: string) {
      return this;
    },
    command(subName: string, subDesc?: string) {
      const sub = mockCommanderGroup(subName);
      sub.description = subDesc ?? '';
      this.subcommands.push(sub);
      return sub;
    },
  };
  return cmd;
}

// ---------------------------------------------------------------------------
// createChannelCommand tests
// ---------------------------------------------------------------------------
describe('createChannelCommand', () => {
  let service: ChannelService;
  let parentCmd: MockCommand;
  let setCredential: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const registry = createChannelRegistry();
    registry.register('test-type', InMemoryChannelAdapter);
    service = new ChannelService(registry, vi.fn());
    parentCmd = mockCommanderGroup('channel');
    setCredential = vi.fn();
  });

  afterEach(async () => {
    await service.dispose();
  });

  it('returns the parent command group', () => {
    const result = createChannelCommand(parentCmd as any, service, setCredential);
    expect(result).toBe(parentCmd);
    expect(parentCmd.name).toBe('channel');
  });

  it('registers subcommands: list, connect, disconnect, send, config, test', () => {
    createChannelCommand(parentCmd as any, service, setCredential);
    const names = parentCmd.subcommands.map((c) => c.name);
    expect(names).toContain('list');
    expect(names).toContain('connect');
    expect(names).toContain('disconnect');
    expect(names).toContain('send');
    expect(names).toContain('config');
    expect(names).toContain('test');
  });

  describe('list command', () => {
    it('lists registered channels', async () => {
      createChannelCommand(parentCmd as any, service, setCredential);
      const listCmd = parentCmd.subcommands.find((c) => c.name === 'list')!;

      // Register a channel first
      const adapter = new InMemoryChannelAdapter(
        { id: 'ch1', type: 'test-type' as ChannelType, enabled: true, credential: 'cred1' },
        vi.fn(),
      );
      service.registerChannel(adapter);

      // We just verify the command exists and can be invoked without error
      expect(listCmd).toBeDefined();
      expect(listCmd.description).toBeTruthy();
      await listCmd.action();
    });
  });

  describe('connect command', () => {
    it('connects a channel by id', async () => {
      createChannelCommand(parentCmd as any, service, setCredential);
      const connectCmd = parentCmd.subcommands.find((c) => c.name === 'connect')!;

      // Register and pre-connect
      const adapter = new InMemoryChannelAdapter(
        { id: 'ch2', type: 'test-type' as ChannelType, enabled: true, credential: 'cred2' },
        vi.fn(),
      );
      service.registerChannel(adapter);
      const connectSpy = vi.spyOn(adapter, 'connect');

      await connectCmd.action('ch2');
      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe('disconnect command', () => {
    it('disconnects a channel by id', async () => {
      createChannelCommand(parentCmd as any, service, setCredential);
      const disconnectCmd = parentCmd.subcommands.find((c) => c.name === 'disconnect')!;

      const adapter = new InMemoryChannelAdapter(
        { id: 'ch3', type: 'test-type' as ChannelType, enabled: true, credential: 'cred3' },
        vi.fn(),
      );
      service.registerChannel(adapter);
      const disconnectSpy = vi.spyOn(adapter, 'disconnect');

      await disconnectCmd.action('ch3');
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });

  describe('send command', () => {
    it('sends a message through a channel', async () => {
      createChannelCommand(parentCmd as any, service, setCredential);
      const sendCmd = parentCmd.subcommands.find((c) => c.name === 'send')!;

      const adapter = new InMemoryChannelAdapter(
        { id: 'ch4', type: 'test-type' as ChannelType, enabled: true, credential: 'cred4' },
        vi.fn(),
      );
      service.registerChannel(adapter);
      await adapter.connect();
      const sendSpy = vi.spyOn(adapter, 'send');

      await sendCmd.action('ch4', 'hello world');
      expect(sendSpy).toHaveBeenCalledWith('hello world');
    });
  });
});
