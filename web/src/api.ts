/**
 * HTTP client wrapper for the Svarla API.
 * Automatically includes session token from localStorage and
 * handles 401 responses by redirecting to login.
 */

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ApiResponse<T> {
  ok: boolean;
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = getSessionToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Handle 401 by dispatching session-expired event
  if (res.status === 401 && path !== '/api/auth/login') {
    clearSession();
    window.dispatchEvent(new Event("session-expired"));
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
