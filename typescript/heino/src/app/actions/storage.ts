"use server";

import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { StorageService } from "buf/gen/richter/v1/storage_pb";

export async function getUploadUrl(key: string, contentType: string): Promise<string> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(StorageService, token);
  const res = await client.getUploadUrl({ key, contentType, expiresInSeconds: 3600 });
  return res.uploadUrl;
}

export async function getDownloadUrl(key: string): Promise<string> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(StorageService, token);
  const res = await client.getDownloadUrl({ key, expiresInSeconds: 3600 });
  return res.downloadUrl;
}
