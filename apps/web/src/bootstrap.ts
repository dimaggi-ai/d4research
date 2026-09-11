import { showBootError } from "./lib/bootError";
import { installChunkLoadRecovery } from "./lib/chunkReloadGuard";
import { retireServiceWorker } from "./serviceWorkerRegistration";

installChunkLoadRecovery();
void retireServiceWorker();

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
