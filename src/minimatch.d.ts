declare module 'minimatch' {
  function minimatch(target: string, pattern: string, options?: { matchBase?: boolean }): boolean;
  export = minimatch;
}
