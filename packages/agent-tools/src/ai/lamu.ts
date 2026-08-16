import type {
  AiProposalRequest,
  AiProvider,
  AiProviderResponse,
  LamuAdapterOptions,
} from './types.js';
import { requireNonempty } from './primitives.js';

/** First local adapter. Transport injection keeps LAMU process/network details out of policy. */
export class LamuProvider implements AiProvider {
  readonly providerId = 'lamu';
  readonly locality = 'local' as const;
  readonly modelId: string;
  readonly #invoke: LamuAdapterOptions['invoke'];

  constructor(options: LamuAdapterOptions) {
    this.modelId = requireNonempty(options.modelId, 'LAMU modelId');
    this.#invoke = options.invoke;
  }

  propose(request: AiProposalRequest): Promise<AiProviderResponse> {
    return this.#invoke(request);
  }
}
