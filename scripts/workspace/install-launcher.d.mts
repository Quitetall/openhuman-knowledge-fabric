// Types for install-launcher.mjs, for the TypeScript that imports it (tests/deployment).
export declare function launcherFiles(home?: string): {
  desktop: string;
  icon: string;
  config: string;
};
export declare function execArg(value: string): string;
export declare function desktopEntry(input: {
  node: string;
  launcher: string;
  icon: string;
}): string;
export declare function recordedPath(envPath?: string): string;
