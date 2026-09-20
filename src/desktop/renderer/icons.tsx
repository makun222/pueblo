import React from 'react';

export type AppIconName =
  | 'session'
  | 'approvals'
  | 'todo'
  | 'theme'
  | 'close'
  | 'plus'
  | 'send'
  | 'remove'
  | 'chevron';

/** Back-compat alias retained so existing consumers keep compiling. */
export type ToolbarIconName = AppIconName;
export type ThemeName = 'legacy' | 'pueblo' | 'dark';

interface IconDef {
  legacy: React.ReactNode;
  pueblo: React.ReactNode;
}

/** Shared 24x24 line-icon frame: 1.5px stroke, round caps/joins, currentColor. */
function Line24({ children }: { children: React.ReactNode }) {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </g>
  );
}

/* Proposal line art (24x24 grid). Reused for both variants on new glyphs so
   legacy and pueblo stay visually identical. */
const closeArt = (
  <Line24>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </Line24>
);

const plusArt = (
  <Line24>
    <path d="M12 5v14M5 12h14" />
  </Line24>
);

const sendArt = (
  <Line24>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
  </Line24>
);

const removeArt = (
  <Line24>
    <path d="M6 6l12 12M18 6 6 18" />
  </Line24>
);

/** Chevron pointing left (rail collapse direction). CSS rotates it 180deg when collapsed. */
const chevronArt = (
  <Line24>
    <path d="M14.5 6 9 12l5.5 6" />
  </Line24>
);

const ICONS: Record<AppIconName, IconDef> = {
  session: {
    legacy: (
      <path
        d="M4 6.75C4 5.78 4.78 5 5.75 5h12.5C19.22 5 20 5.78 20 6.75v2.5C20 10.22 19.22 11 18.25 11H5.75C4.78 11 4 10.22 4 9.25v-2.5Zm0 8C4 13.78 4.78 13 5.75 13h12.5c.97 0 1.75.78 1.75 1.75v2.5c0 .97-.78 1.75-1.75 1.75H5.75C4.78 19 4 18.22 4 17.25v-2.5Zm2 1.25v1.5h4V16h-4Zm0-8v1.5h7V8H6Z"
        fill="currentColor"
      />
    ),
    pueblo: (
      <Line24>
        <path d="M4 17 10 11 4 5" />
        <path d="M12 19h8" />
      </Line24>
    ),
  },
  approvals: {
    legacy: (
      <path
        d="M6 5.75A1.75 1.75 0 0 1 7.75 4h8.5A1.75 1.75 0 0 1 18 5.75v1.5A1.75 1.75 0 0 1 16.25 9h-8.5A1.75 1.75 0 0 1 6 7.25v-1.5Zm-2 7A1.75 1.75 0 0 1 5.75 11h12.5A1.75 1.75 0 0 1 20 12.75v5.5A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25v-5.5Zm3 1.75v2.5h3v-2.5H7Zm5 0v2.5h5v-2.5h-5Z"
        fill="currentColor"
      />
    ),
    pueblo: (
      <Line24>
        <path d="M20 6 9 17l-5-5" />
      </Line24>
    ),
  },
  todo: {
    legacy: (
      <path
        d="M6.75 5A1.75 1.75 0 0 0 5 6.75v10.5C5 18.22 5.78 19 6.75 19h10.5c.97 0 1.75-.78 1.75-1.75V6.75C19 5.78 18.22 5 17.25 5H6.75Zm1.5 3.25h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Zm0 3.5h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Zm0 3.5h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Z"
        fill="currentColor"
      />
    ),
    pueblo: (
      <Line24>
        <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
      </Line24>
    ),
  },
  theme: {
    legacy: <path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" />,
    pueblo: (
      <Line24>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
      </Line24>
    ),
  },
  close: {
    legacy: closeArt,
    pueblo: closeArt,
  },
  plus: {
    legacy: plusArt,
    pueblo: plusArt,
  },
  send: {
    legacy: sendArt,
    pueblo: sendArt,
  },
  remove: {
    legacy: removeArt,
    pueblo: removeArt,
  },
  chevron: {
    legacy: chevronArt,
    pueblo: chevronArt,
  },
};

export function ToolbarIcon({ name, theme }: { name: AppIconName; theme: ThemeName }) {
  const def = ICONS[name];
  const art = theme === 'legacy' ? def.legacy : def.pueblo;
  return (
    <svg className="app-toolbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      {art}
    </svg>
  );
}
