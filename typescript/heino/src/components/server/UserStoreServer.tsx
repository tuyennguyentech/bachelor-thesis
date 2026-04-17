import { createClient } from "@connectrpc/connect";
import { PutUserResponseSchema, UserRole, UserStoreService } from "buf/gen/tmp/v1/tmp_pb";
import { createConnectTransport } from "@connectrpc/connect-node";
import { toBinary, toJson, toJsonString } from "@bufbuild/protobuf";

const transport = createConnectTransport({
  httpVersion: "2",
  baseUrl: "http://richter:8080/api",
})

export default async function UserStoreServer() {
  const client = createClient(UserStoreService, transport)
  const res = await client.putUser({
    userId: "123",
    name: "John Doe",
    age: 30,
    role: UserRole.USER,
  })

  return <>
    <div>Json: {toJsonString(PutUserResponseSchema, res, {
      prettySpaces: 8,
      // useProtoFieldName: true,
    })}</div>
    <div>Bin: {toBinary(PutUserResponseSchema, res)}</div>
  </>
}


