/**
 * HTTP client wrapper for the Svarla API.
 * Automatically includes session token from localStorage and
 * handles 401 responses by redirecting to login.
 */

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ApiResponse<T> {
  ok: true;
  status: number;
  data: T;
}

interface ApiError {
  ok: false;
  status: number;
  data: { error: string; details?: unknown };
}

function getSessionToken(): string | null {
  return localStorage.getItem("session_token");
}

function clearSession(): void {
  localStorage.removeItem("session_token");
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<ApiResponse<T> | ApiError> {
  const headers: Record<string, string> = {};

  // Only advertise a JSON body when there actually is one. Sending
  // `Content-Type: application/json` on a bodyless request (e.g. the bodyless
  // POSTs used by decline/hangup/answer) makes Fastify's content-type parser
  // reject it with FST_ERR_CTP_EMPTY_JSON_BODY (400) before the route runs —
  // which previously caused declines to silently fail server-side, leaving the
  // call ringing on other devices.
  const hasBody = body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  const token = getSessionToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  // Handle 401 by clearing the session and signalling session-expiry.
  //
  // The auth endpoints are exempt: a 401 from /api/auth/login is a wrong
  // password (handled by the login form), and a 401 from /api/auth/logout means
  // the session was already gone — treating it as a fresh expiry would re-fire
  // logout, which 401s again, spinning an infinite loop.
  //
  // We also only dispatch when a token is actually present. `clearSession()`
  // removes it, so the first 401 tears down the session and any concurrent or
  // subsequent 401s (e.g. the ws-triggered device reconcile) find no token and
  // stay quiet. A later successful login re-adds the token and re-arms this.
  const isAuthEndpoint =
    path === "/api/auth/login" || path === "/api/auth/logout";
  if (res.status === 401 && !isAuthEndpoint) {
    if (getSessionToken()) {
      clearSession();
      window.dispatchEvent(new Event("session-expired"));
    }
    return {
      ok: false,
      status: 401,
      data: { error: "Session expired" },
    };
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: data ?? { error: res.statusText },
    };
  }

  return {
    ok: true,
    status: res.status,
    data: data as T,
  };
}

export const api = {
  get<T>(path: string) {
    return request<T>("GET", path);
  },
  post<T>(path: string, body?: unknown) {
    return request<T>("POST", path, body);
  },
  put<T>(path: string, body?: unknown) {
    return request<T>("PUT", path, body);
  },
  delete<T>(path: string) {
    return request<T>("DELETE", path);
  },
  patch<T>(path: string, body?: unknown) {
    return request<T>("PATCH", path, body);
  },
};
