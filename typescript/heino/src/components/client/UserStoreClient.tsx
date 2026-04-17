'use client'

import { useMemo } from 'react'
import { type DescService } from '@bufbuild/protobuf'
import { createConnectTransport } from "@connectrpc/connect-web"
import { createClient, type Client } from "@connectrpc/connect"
import { UserRole, UserStoreService } from "buf/gen/tmp/v1/tmp_pb"

const transport = createConnectTransport({
  baseUrl: "/api"
})

export function useClient<T extends DescService>(service: T): Client<T> {
  return useMemo(() => createClient(service, transport), [service]);
}

export default function UserStoreClient() {
  const client = useClient(UserStoreService);

  async function handlePutUser() {
    const user = await client.putUser({
      userId: "1",
      name: "a",
      age: 10,
      role: UserRole.USER,
    });
    console.log(user);
  }

  return <button onClick={handlePutUser}>Put User</button>;
}
