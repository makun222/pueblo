/**
 * Deterministic agent avatar resolution for the desktop renderer.
 *
 * Resolution order for a profile:
 *   1. A configured avatar that points at an image (URL / data-URI / asset path).
 *   2. A named asset override (`AGENT_AVATAR_ASSETS`) bound to the profile id.
 *   3. A configured glyph (emoji / short symbol) rendered into an SVG badge.
 *   4. A generated monogram SVG derived from the profile name (or id).
 *   5. The provided fallback src (e.g. the built-in Pueblo avatar).
 *
 * Everything except an explicit image is emitted as a self-contained SVG
 * data-URI, so the avatar stays legible on light and dark themes without
 * relying on inherited CSS variables (which do not cross into <img> documents).
 */

export interface AgentAvatarInput {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly avatar?: string | null;
}

/**
 * Optional overrides: bind a profile id (or a configured avatar key) to a real
 * imported image URL. Populate this when binary avatar assets become available.
 */
export const AGENT_AVATAR_ASSETS: Record<string, string> = {};

const AVATAR_PALETTE: readonly { readonly from: string; readonly to: string }[] = [
  { from: '#4f46e5', to: '#7c3aed' },
  { from: '#0f766e', to: '#14b8a6' },
  { from: '#b45309', to: '#f59e0b' },
  { from: '#be123c', to: '#f43f5e' },
  { from: '#1d4ed8', to: '#38bdf8' },
  { from: '#7e22ce', to: '#c026d3' },
  { from: '#15803d', to: '#4ade80' },
  { from: '#c2410c', to: '#fb923c' },
  { from: '#0e7490', to: '#22d3ee' },
  { from: '#a16207', to: '#facc15' },
];

const IMAGE_SRC_PATTERN = /^(?:data:image\/|https?:\/\/|file:|[./\\])|\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i;

export function resolveAgentAvatarSrc(
  profile: AgentAvatarInput | null | undefined,
  fallbackSrc: string,
): string {
  if (!profile) {
    return fallbackSrc;
  }

  const configured = typeof profile.avatar === 'string' ? profile.avatar.trim() : '';
  if (configured) {
    const namedAsset = AGENT_AVATAR_ASSETS[configured];
    if (namedAsset) {
      return namedAsset;
    }
    if (IMAGE_SRC_PATTERN.test(configured)) {
      return configured;
    }
    return buildGlyphAvatarDataUri(configured, resolveSeed(profile));
  }

  const idAsset = profile.id ? AGENT_AVATAR_ASSETS[profile.id] : undefined;
  if (idAsset) {
    return idAsset;
  }

  const monogram = extractMonogram(profile.name) ?? extractMonogram(profile.id);
  if (monogram) {
    return buildMonogramAvatarDataUri(monogram, resolveSeed(profile));
  }

  return fallbackSrc;
}

function resolveSeed(profile: AgentAvatarInput): string {
  return profile.id?.trim() || profile.name?.trim() || 'agent';
}

function extractMonogram(value: string | null | undefined): string | null {
  const first = firstGrapheme(value);
  return first ? first.toUpperCase() : null;
}

/**
 * Returns the first user-perceived character. Uses grapheme segmentation when
 * available so emoji with variation selectors (e.g. "🏛️") stay intact instead
 * of being truncated to a lone code point.
 */
function firstGrapheme(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const segment of segmenter.segment(trimmed)) {
      return segment.segment;
    }
  } catch {
    // Fall through to code-point based extraction.
  }

  const [first] = Array.from(trimmed);
  return first ?? null;
}

function pickPalette(seed: string): { readonly from: string; readonly to: string } {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }

  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function buildGlyphAvatarDataUri(glyph: string, seed: string): string {
  const symbol = firstGrapheme(glyph) ?? '?';
  return buildAvatarDataUri({
    seed,
    label: symbol,
    fontSize: 18,
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  });
}

function buildMonogramAvatarDataUri(monogram: string, seed: string): string {
  return buildAvatarDataUri({
    seed,
    label: monogram,
    fontSize: 15,
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    fontWeight: 700,
    fill: '#ffffff',
  });
}

function buildAvatarDataUri(args: {
  seed: string;
  label: string;
  fontSize: number;
  fontFamily: string;
  fontWeight?: number;
  fill?: string;
}): string {
  const { from, to } = pickPalette(args.seed);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img">',
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    '<rect width="32" height="32" rx="8" fill="url(#g)"/>',
    `<text x="16" y="16.5" text-anchor="middle" dominant-baseline="central"` +
      ` font-family='${args.fontFamily}' font-size="${args.fontSize}"` +
      (args.fontWeight ? ` font-weight="${args.fontWeight}"` : '') +
      (args.fill ? ` fill="${args.fill}"` : '') +
      `>${escapeXml(args.label)}</text>`,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
