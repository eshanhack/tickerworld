export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class ServiceUnavailableError extends ServiceError {
  constructor(code: string, message: string) {
    super(503, code, message);
  }
}

export class RateLimitError extends ServiceError {
  constructor(code: string, message: string, public readonly retryAfterMs: number) {
    super(429, code, message);
  }
}

export class InputError extends ServiceError {
  constructor(code: string, message: string) {
    super(400, code, message);
  }
}

export class UnauthorizedError extends ServiceError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message);
  }
}

export class ConflictError extends ServiceError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
