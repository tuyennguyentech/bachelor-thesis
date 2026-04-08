import UserStoreClient from "@/components/client/UserStoreClient";
import UserStoreServer from "@/components/server/UserStoreServer";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/client/mode-toggle";

export default function Home() {
  return (
    <>
      <ModeToggle />
      <UserStoreClient />
      <UserStoreServer />
      <Card className="max-w-sm bg-card">
        <CardHeader className="text-card-foreground">
          <CardTitle>Project Overview</CardTitle>
          <CardDescription>
            Track progress and recent activity for your Next.js app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          Your design system is ready. Start building your next component.
        </CardContent>
      </Card>
      <div className="flex items-center justify-center">
        <Button>Click me</Button>
      </div>
    </>
  );
}
