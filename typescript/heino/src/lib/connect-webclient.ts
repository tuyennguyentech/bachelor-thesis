import { type DescService } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-web";
import { Client, createClient } from "@connectrpc/connect";
import { useMemo } from "react";


const richterBaseUrl = process.env.NEXT_PUBLIC_RICHTER_BASE_URL;

if (!richterBaseUrl) {
  throw Error("NEXT_PUBLIC_RICHTER_BASE_URL must be provided");
}

const richterTransport = createConnectTransport({
  baseUrl: richterBaseUrl,
});

export function useRichterWebClient<T extends DescService>(service: T): Client<T> {
  return useMemo(() => createClient(service, richterTransport), [service]);
}
