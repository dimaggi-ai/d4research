import { createFileRoute } from "@tanstack/react-router";

import { SystemPage } from "../components/SystemPage";

export const Route = createFileRoute("/system")({
  component: SystemPage,
});
