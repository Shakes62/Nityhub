import { API_BASE } from "@/constants/config";
import { auth } from "@/lib/firebase";
import { ApiError, type ApiResponse, type RequestOptions } from "@/types/api";

/**
 * Centralized API client for the NityHub backend.
 *
 * Every network call in the app goes through `apiRequest` so that headers,
 * authentication, error normalization, and retries live in exactly one place
 * (mirrors — and consolidates — the original public/js/common.js apiRequest).
 *
 * Contract preserved from the legacy client:
 *   - JSON bodies send `Content-Type: application/json`.
 *   - Every request sends `X-Request-Timestamp` and `X-Requested-With`.
 *   - Authenticated calls attach the Firebase ID token as a Bearer credential.
 *   - Responses are treated as errors when `!res.ok` OR `payload.status === "error"`.
 */

const REQUESTED_WITH = "NityHubWeb";
/** Retry idempotent GETs a couple of times on transient network failures. */
const MAX_GET_RETRIES = 2;

async function getIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError("Not logged in", { status: 401 });
  }
  return user.getIdToken();
}

function buildUrl(path: string): string {
  return /^https?:/i.test(path) ? path : `${API_BASE}${path}`;
}

/** Response interceptor: parse body and normalize failures into ApiError. */
async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const rawBody = await response.text();

  let payload: ApiResponse<T> | null = null;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as ApiResponse<T>) : null;
  } catch {
    const looksLikeHtml = /^\s*</.test(rawBody || "");
    throw new ApiError(
      looksLikeHtml
        ? "Invalid server response. Check the API base URL and CORS configuration."
        : "Invalid server response",
      { status: response.status },
    );
  }

  if (!response.ok || payload?.status === "error") {
    throw new ApiError(payload?.message || `Request failed (${response.status})`, {
      status: response.status,
      payload,
    });
  }

  return payload ?? ({} as ApiResponse<T>);
}

async function performRequest<T>(
  path: string,
  options: RequestOptions,
  attempt: number,
): Promise<ApiResponse<T>> {
  const {
    json,
    auth: withAuth,
    authOptional: withOptionalAuth,
    headers: providedHeaders,
    ...rest
  } = options;
  const method = (rest.method || "GET").toUpperCase();

  // Request interceptor: assemble headers consistently for every call.
  const headers = new Headers(providedHeaders as HeadersInit | undefined);
  headers.set("X-Request-Timestamp", Date.now().toString());
  headers.set("X-Requested-With", REQUESTED_WITH);

  let body = rest.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }

  if (withAuth) {
    headers.set("Authorization", `Bearer ${await getIdToken()}`);
  } else if (withOptionalAuth && auth.currentUser) {
    // Best-effort: a token failure here must not break a public endpoint, so
    // fall through and let the server treat the call as anonymous.
    try {
      headers.set("Authorization", `Bearer ${await auth.currentUser.getIdToken()}`);
    } catch {
      /* send anonymously */
    }
  }

  try {
    const response = await fetch(buildUrl(path), { ...rest, method, headers, body });
    return await parseResponse<T>(response);
  } catch (error) {
    // Retry only idempotent reads on genuine network errors (not ApiErrors).
    const isNetworkError = !(error instanceof ApiError);
    if (isNetworkError && method === "GET" && attempt < MAX_GET_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      return performRequest<T>(path, options, attempt + 1);
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      { status: 0 },
    );
  }
}

/** Make a request to the NityHub API and return the parsed envelope. */
export function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  return performRequest<T>(path, options, 0);
}

/** Convenience wrapper returning `data`, throwing if it is absent. */
export async function apiData<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await apiRequest<T>(path, options);
  return response.data as T;
}
