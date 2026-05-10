import { cache } from "react";
import { DescService } from "@bufbuild/protobuf";
import { Client, createClient, Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

const richterBaseUrl = process.env.RICHTER_BASE_URL;

if (!richterBaseUrl) {
  throw Error("RICHTER_BASE_URL must be provided");
}

const richterTransport = createConnectTransport({
  httpVersion: "2",
  baseUrl: richterBaseUrl,
});

// cache() deduplicates transport creation per token per request render pass
const getAuthTransport = cache((token: string) => {
  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  return createConnectTransport({
    httpVersion: "2",
    baseUrl: richterBaseUrl!,
    interceptors: [authInterceptor],
  });
});

export function createRichterClient<T extends DescService>(service: T, token?: string): Client<T> {
  if (!token) return createClient(service, richterTransport);
  return createClient(service, getAuthTransport(token));
}
