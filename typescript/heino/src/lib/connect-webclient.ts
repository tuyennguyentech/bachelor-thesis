"use client";
import { type DescService } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-web";
import { Client, Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { useEffect, useMemo, useRef } from "react";

const richterBaseUrl = process.env.NEXT_PUBLIC_RICHTER_BASE_URL;
if (!richterBaseUrl) throw new Error("NEXT_PUBLIC_RICHTER_BASE_URL must be provided");

// ── Singleton refresh deduplication ──────────────────────────────────────────
// Dedupes concurrent 401s from multiple simultaneous RPC calls.

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch("/api/auth/refresh", { method: "POST" })
    .then(r => r.ok ? r.json().then((d: { accessToken: string }) => d.accessToken) : null)
    .catch(() => null)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRichterWebClient<T extends DescService>(service: T, token?: string): Client<T> {
  const tokenRef = useRef(token);

  // Sync latest token into the ref so the interceptor always reads the current
  // value — also picks up tokens refreshed server-side on next navigation.
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  return useMemo(() => {
    const authInterceptor: Interceptor = (next) => async (req) => {
      if (tokenRef.current) {
        req.header.set("Authorization", `Bearer ${tokenRef.current}`);
      }

      // Streams: skip retry — surface 401 to caller (retrying a stream is
      // complex; the user will see an error and can re-trigger).
      if (req.stream) return next(req);

      // Unary: attempt once, then retry once after a token refresh on 401.
      try {
        return await next(req);
      } catch (err) {
        if (
          err instanceof ConnectError &&
          err.code === Code.Unauthenticated &&
          tokenRef.current
        ) {
          const newToken = await refreshAccessToken();
          if (newToken) {
            tokenRef.current = newToken;
            req.header.set("Authorization", `Bearer ${newToken}`);
            return await next(req); // retry once — if this also 401s, propagate
          }
          // Refresh failed or no refresh cookie — redirect to login.
          if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
            window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          }
        }
        throw err;
      }
    };

    const transport = createConnectTransport({
      baseUrl: richterBaseUrl!,
      interceptors: [authInterceptor],
    });
    return createClient(service, transport);
  }, [service]); // tokenRef is a stable ref — no need to re-create on token change
}
