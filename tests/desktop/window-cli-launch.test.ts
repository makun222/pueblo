import { describe, expect, it, vi } from 'vitest';
import { launchDesktopDialog } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';

describe('Desktop CLI Launch Handoff', () => {
  it('should hand off no-argument startup to a new desktop dialog process', async () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue({ unref });
    const write = vi.fn();

    await launchDesktopDialog(createTestAppConfig(), {
      cwd: 'd:/workspace/trends/pueblo',
      electronBinary: 'C:/tools/electron.exe',
      spawnImpl: spawnImpl as never,
      write,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'C:/tools/electron.exe',
      ['d:\\workspace\\trends\\pueblo'],
      expect.objectContaining({
        cwd: 'd:\\workspace\\trends\\pueblo',
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('Opening Pueblo desktop dialog...\n');
  });
});