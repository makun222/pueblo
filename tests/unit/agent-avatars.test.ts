import { describe, expect, it } from 'vitest';
import { resolveAgentAvatarSrc } from '../../src/desktop/renderer/agent-avatars';

const FALLBACK = 'resources/pueblo.jpg';

function decodeGlyph(src: string): string {
  const encoded = src.slice(src.indexOf(',') + 1);
  return decodeURIComponent(encoded);
}

describe('resolveAgentAvatarSrc', () => {
  it('returns the fallback when no profile is available', () => {
    expect(resolveAgentAvatarSrc(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentAvatarSrc(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentAvatarSrc({}, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentAvatarSrc({ id: 'x', name: '   ', avatar: null }, FALLBACK)).not.toBe(FALLBACK);
  });

  it('renders a configured emoji into a self-contained SVG data-URI', () => {
    const src = resolveAgentAvatarSrc({ id: 'architect', name: 'Architect', avatar: '🏛️' }, FALLBACK);
    expect(src).toContain('data:image/svg+xml');
    expect(decodeGlyph(src)).toContain('🏛️');
  });

  it('passes configured image sources through untouched', () => {
    expect(resolveAgentAvatarSrc({ id: 'a', name: 'A', avatar: 'https://cdn.example/fox.png' }, FALLBACK))
      .toBe('https://cdn.example/fox.png');
    expect(resolveAgentAvatarSrc({ id: 'a', name: 'A', avatar: './avatars/fox.svg' }, FALLBACK))
      .toBe('./avatars/fox.svg');
    expect(resolveAgentAvatarSrc({ id: 'a', name: 'A', avatar: 'data:image/png;base64,AAAA' }, FALLBACK))
      .toBe('data:image/png;base64,AAAA');
  });

  it('falls back to a deterministic monogram when no avatar is configured', () => {
    const first = resolveAgentAvatarSrc({ id: 'architect', name: 'Architect' }, FALLBACK);
    const second = resolveAgentAvatarSrc({ id: 'architect', name: 'Architect' }, FALLBACK);
    const other = resolveAgentAvatarSrc({ id: 'writer', name: 'Writer' }, FALLBACK);

    expect(first).toContain('data:image/svg+xml');
    expect(decodeGlyph(first)).toContain('>A<');
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});
