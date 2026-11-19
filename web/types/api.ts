/** Shared API envelope + error types for the NityHub backend. */

/** Standard response envelope returned by every endpoint. */
export interface ApiResponse<T = unknown> {
  status?: "success" | "error" | "pending" | "failed" | (string & {});
  message?: string;
  data?: T;
  [key: string]: unknown;
}

/** Normalized error thrown by the API client on any failed request. */
export class ApiError extends Error {
  /** HTTP status code, or 0 for network/parse failures. */
  readonly status: number;
  /** Raw parsed payload when the server returned structured JSON. */
  readonly payload: ApiResponse | null;
  /** Backend-provided machine code, e.g. "INSUFFICIENT_WALLET_BALANCE". */
  readonly errorCode?: string;

  constructor(
    message: string,
    options: { status?: number; payload?: ApiResponse | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.payload = options.payload ?? null;
    this.errorCode =
      typeof options.payload?.errorCode === "string"
        ? options.payload.errorCode
        : undefined;
  }
}

/** Options accepted by the API client (superset of fetch RequestInit). */
export interface RequestOptions extends RequestInit {
  /** JSON-serializable body; the client stringifies it and sets Content-Type. */
  json?: unknown;
  /** Attach the current user's Firebase ID token as a Bearer credential. */
  auth?: boolean;
  /**
   * Attach the ID token when a user is signed in, but send the request
   * anonymously rather than failing when one is not. For public endpoints whose
   * response is personalized server-side (e.g. the package catalog, where the
   * backend resolves the caller's price tier).
   */
  authOptional?: boolean;
}
