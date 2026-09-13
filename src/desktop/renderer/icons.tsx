import React from 'react';

export type ToolbarIconName = 'session' | 'approvals' | 'todo' | 'theme';
export type ThemeName = 'legacy' | 'pueblo' | 'dark';

interface IconDef {
  legacy: React.ReactNode;
  pueblo: React.ReactNode;
}

const ICONS: Record<ToolbarIconName, IconDef> = {
  session: {
    legacy: (
      <path
        d="M4 6.75C4 5.78 4.78 5 5.75 5h12.5C19.22 5 20 5.78 20 6.75v2.5C20 10.22 19.22 11 18.25 11H5.75C4.78 11 4 10.22 4 9.25v-2.5Zm0 8C4 13.78 4.78 13 5.75 13h12.5c.97 0 1.75.78 1.75 1.75v2.5c0 .97-.78 1.75-1.75 1.75H5.75C4.78 19 4 18.22 4 17.25v-2.5Zm2 1.25v1.5h4V16h-4Zm0-8v1.5h7V8H6Z"
        fill="currentColor"
      />
    ),
    pueblo: (
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="5" width="7" height="6.5" rx="1.75" />
        <rect x="13" y="5" width="7" height="6.5" rx="1.75" />
        <rect x="4" y="13.5" width="7" height="6.5" rx="1.75" />
        <rect x="13" y="13.5" width="7" height="6.5" rx="1.75" />
      </g>
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
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="4.5" width="16" height="4.5" rx="1.75" />
        <rect x="4" y="12.5" width="7" height="7" rx="1.75" />
        <rect x="13" y="12.5" width="7" height="7" rx="1.75" />
      </g>
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
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="4.5" width="16" height="15" rx="2.5" />
        <path d="M7.5 9.25h9M7.5 13.25h9M7.5 17.25h5" />
      </g>
    ),
  },
  theme: {
    legacy: <path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" />,
    pueblo: (
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
      </g>
    ),
  },
};

export function ToolbarIcon({ name, theme }: { name: ToolbarIconName; theme: ThemeName }) {
  return (
    <svg className="app-toolbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name][theme === 'pueblo' ? 'pueblo' : 'legacy']}
    </svg>
  );
}
