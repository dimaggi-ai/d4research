// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { prepareServerBuildDirectory } from "./server-build-artifacts.ts";

const serverDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
await prepareServerBuildDirectory(serverDirectory);
