export class BlockedByRobotsError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "BlockedByRobotsError";
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly host: string, readonly until: number) {
    super(`circuit open for ${host} until ${new Date(until * 1000).toISOString()}`);
    this.name = "CircuitOpenError";
  }
}

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export class TooLargeError extends Error {
  constructor(readonly url: string, readonly limit: number) {
    super(`response for ${url} exceeds ${limit} bytes`);
    this.name = "TooLargeError";
  }
}
