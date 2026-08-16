export interface PandocNode {
  readonly t?: unknown;
  readonly c?: unknown;
}

export interface PandocDocument {
  readonly 'pandoc-api-version'?: unknown;
  readonly meta?: unknown;
  readonly blocks?: unknown;
}
