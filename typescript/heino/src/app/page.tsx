import UserStoreClient from "@/components/client/UserStoreClient";
import UserStoreServer from "@/components/server/UserStoreServer";

export default function Home() {
  return (
    <>
      <UserStoreClient />
      <UserStoreServer />
    </>
  );
}
