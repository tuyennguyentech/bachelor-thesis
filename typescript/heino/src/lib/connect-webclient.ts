"use client";
import { type DescService } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-web";
import { Client, createClient, type Interceptor } from "@connectrpc/connect";
import { useMemo } from "react";

const richterBaseUrl = process.env.NEXT_PUBLIC_RICHTER_BASE_URL;
if (!richterBaseUrl) throw new Error("NEXT_PUBLIC_RICHTER_BASE_URL must be provided");

const unauthTransport = createConnectTransport({ baseUrl: richterBaseUrl });

export function useRichterWebClient<T extends DescService>(service: T, token?: string): Client<T> {
  return useMemo(() => {
    if (!token) return createClient(service, unauthTransport);
    const authInterceptor: Interceptor = (next) => (req) => {
      req.header.set("Authorization", `Bearer ${token}`);
      return next(req);
    };
    const transport = createConnectTransport({ baseUrl: richterBaseUrl!, interceptors: [authInterceptor] });
    return createClient(service, transport);
  }, [service, token]);
}
