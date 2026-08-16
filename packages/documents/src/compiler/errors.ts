export class DocumentCompilerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentCompilerError';
    this.code = code;
  }
}
