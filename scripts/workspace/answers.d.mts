// Types for answers.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
export type AnswerChoice = 'off' | 'on_host' | 'cloud' | 'both';
export declare const ANSWER_CHOICES: readonly AnswerChoice[];
export declare const ON_HOST_MODEL_CANDIDATES: readonly string[];
export interface CloudProviderEntry {
  readonly name: string;
  readonly transport: 'anthropic' | 'openai_compatible';
  readonly baseUrl?: string;
  readonly models?: readonly string[];
}
export declare const CLOUD_PROVIDERS: Readonly<Record<string, CloudProviderEntry>>;
export interface CloudForm {
  provider?: string;
  model?: string;
  baseUrl?: string;
  name?: string;
}
export interface SavedCloud {
  readonly provider: string;
  readonly name: string;
  readonly transport: 'anthropic' | 'openai_compatible';
  readonly model: string;
  readonly baseUrl?: string;
}
export interface AnswersInput {
  choice: string;
  key?: string;
  localModel?: string;
  cloud?: CloudForm;
}
export interface SavedAnswers {
  readonly choice: string;
  readonly onHost?: { readonly url: string; readonly model?: string };
  readonly cloud?: SavedCloud;
}
export type OnHostFound =
  | { readonly url: string; readonly models: readonly string[]; readonly reason?: undefined }
  | { readonly reason: string; readonly url?: undefined };
export declare function answersPaths(state: string): { settings: string; keyFile: string };
export declare function usesOnHost(choice: string): boolean;
export declare function usesCloud(choice: string): boolean;
export declare function isLoopbackModelUrl(raw: string): boolean;
export declare function cloudBaseUrl(raw: string): string | undefined;
export declare function cloudLabel(cloud: { name?: string } | undefined): string;
export declare function resolveCloud(
  form?: CloudForm,
): { cloud: SavedCloud; problems?: undefined } | { problems: string[]; cloud?: undefined };
export declare function answersProblems(
  input: AnswersInput,
  found: { onHost?: OnHostFound | undefined; keyOnFile?: string | undefined },
): string[];
export declare function agentEnv(
  answers: SavedAnswers | null | undefined,
  options?: { keyFile?: string; providerBaseUrl?: string },
): Record<string, string>;
export declare function ceilingFor(choice: string): 'none' | 'internal' | undefined;
export declare function answersView(
  answers: SavedAnswers | null | undefined,
  found: { keyOnFile?: string | undefined },
): Record<string, unknown>;
