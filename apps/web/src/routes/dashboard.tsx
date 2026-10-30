import { createFileRoute, redirect } from "@tanstack/react-router";
import { ThreadDashboardPage } from "../components/dashboard/ThreadDashboardPage";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ThreadDashboardPage,
});
