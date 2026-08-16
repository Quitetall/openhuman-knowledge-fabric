export interface MetricView {
  readonly id: string;
  readonly name: string;
  readonly value: string | number;
  readonly unit: string | null;
  readonly recordedAt: string;
  readonly classification: string;
  readonly provenance: string;
}

export type MetricPanel =
  | { readonly status: 'available'; readonly metrics: readonly MetricView[] }
  | {
      readonly status: 'withheld' | 'unavailable' | 'unbound' | 'failed';
      readonly metrics: readonly [];
    };
