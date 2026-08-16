export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionError';
  }
}

export function invalid(field: string): never {
  throw new ProjectionError(`ML projection field ${field} is invalid`);
}
