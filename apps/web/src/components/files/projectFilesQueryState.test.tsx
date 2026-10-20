import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const authorizationMocks = vi.hoisted(() => ({
  sessionAtom: null as Atom.Atom<
    AsyncResult.AsyncResult<Pick<AuthSessionState, "authenticated" | "scopes">, Error>
  > | null,
  phase: "connected" as "connected" | "offline",
}));

vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => authorizationMocks.sessionAtom },
}));

vi.mock("~/state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: authorizationMocks.phase, error: null } },
  }),
}));

const projectMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  optimisticFile: vi.fn(),
  readFile: vi.fn(),
}));

const atomHooks = vi.hoisted(() => ({
  registry: null as {
    get(atom: object): unknown;
    refresh(atom: object): void;
  } | null,
}));

const reactHooks = vi.hoisted(() => {
  let cursor = 0;
  let refs: Array<{ current: unknown }> = [];
  let states: unknown[] = [];
  let effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
  let callbacks: Array<{ deps?: readonly unknown[]; value: unknown }> = [];
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      effects.forEach((effect) => effect?.cleanup?.());
      effects = [];
      callbacks = [];
      cursor = 0;
      refs = [];
      states = [];
    },
    useCallback<A>(callback: A, deps?: readonly unknown[]): A {
      const index = nextIndex();
      if (!same(callbacks[index]?.deps, deps)) callbacks[index] = { deps, value: callback };
      return callbacks[index]!.value as A;
    },
    useMemo<A>(factory: () => A, deps?: readonly unknown[]): A {
      const index = nextIndex();
      if (!same(callbacks[index]?.deps, deps)) callbacks[index] = { deps, value: factory() };
      return callbacks[index]!.value as A;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
      const index = nextIndex();
      if (same(effects[index]?.deps, deps)) return;
      effects[index]?.cleanup?.();
      effects[index] = { deps, cleanup: effect() || undefined };
    },
    useRef<A>(initialValue: A): { current: A } {
      const index = nextIndex();
      refs[index] ??= { current: initialValue };
      return refs[index] as { current: A };
    },
    useState<A>(initialValue: A): [A, (next: A | ((current: A) => A)) => void] {
      const index = nextIndex();
      if (!(index in states)) states[index] = initialValue;
      return [
        states[index] as A,
        (next) => {
          const current = states[index] as A;
          states[index] = typeof next === "function" ? (next as (value: A) => A)(current) : next;
        },
      ];
    },
  };
});

vi.mock("~/hooks/useStableCallback", () => ({
  useStableCallback: (callback: () => void) => {
    const latest = reactHooks.useRef(callback);
    latest.current = callback;
    return reactHooks.useCallback(() => latest.current(), []);
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (atom: object) => () => {
    atomHooks.registry?.refresh(atom);
  },
  useAtomValue: (atom: object) => atomHooks.registry?.get(atom),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: reactHooks.useCallback,
    useEffect: reactHooks.useEffect,
    useMemo: reactHooks.useMemo,
    useState: reactHooks.useState,
    useRef: reactHooks.useRef,
  };
});

vi.mock("~/state/projects", () => ({
  projectEnvironment: projectMocks,
}));

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: vi.fn(),
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { useProjectEntriesQuery, useProjectFileQuery } from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-1");
const decodeReadError = Schema.decodeSync(ProjectReadFileError);

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function file(contents: string): ProjectReadFileResult {
  return {
    relativePath: "src/preview.ts",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

function projectEntries(paths: readonly string[]): ProjectListEntriesResult {
  return {
    entries: paths.map((path) => ({ path, kind: "file" })),
    truncated: false,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("project query refresh", () => {
  beforeEach(() => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
    );
    authorizationMocks.phase = "connected";
    projectMocks.listEntries.mockReset();
    projectMocks.optimisticFile.mockReset();
    projectMocks.readFile.mockReset();
    reactHooks.reset();
  });

  it("does not query or expose optimistic file contents without read permission", () => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [] }),
    );
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
    try {
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(query.data).toBeNull();
      expect(query.error).toBe("This connection cannot read host files.");
      expect(query.isPending).toBe(false);
      const entries = useProjectEntriesQuery(environmentId, "/repo");
      expect(projectMocks.listEntries).not.toHaveBeenCalled();
      expect(entries.data).toBeNull();
      expect(entries.error).toBe("This connection cannot read host files.");
      expect(entries.isPending).toBe(false);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("keeps t3.json and the file tree loading until the file grant arrives", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const config = {
      defaultThreadEnvMode: "worktree",
      scripts: [{ name: "Test", command: "vp test" }],
    };
    projectMocks.readFile.mockReturnValue(
      Atom.make(AsyncResult.success(file(JSON.stringify(config)))),
    );
    projectMocks.listEntries.mockReturnValue(
      Atom.make(AsyncResult.success(projectEntries(["t3.json"]))),
    );
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useT3ProjectFileState(environmentId, "/repo").status).toBe("loading");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(projectMocks.listEntries).not.toHaveBeenCalled();

      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
      );
      expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
        status: "valid",
        file: config,
        scripts: config.scripts,
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: projectEntries(["t3.json"]),
        error: null,
        isPending: false,
      });
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it.each(["connected", "offline"] as const)(
    "preserves cached t3.json defaults and scripts during a granted refresh while %s",
    (phase) => {
      authorizationMocks.phase = phase;
      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success(
          { authenticated: true, scopes: [AuthFilesystemReadScope] },
          { waiting: true },
        ),
      );
      const registry = AtomRegistry.make();
      atomHooks.registry = registry;
      const config = {
        defaultThreadEnvMode: "worktree",
        scripts: [{ name: "Test", command: "vp test" }],
      };
      projectMocks.readFile.mockReturnValue(
        Atom.make(AsyncResult.success(file(JSON.stringify(config)), { waiting: true })),
      );
      projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
      try {
        expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
          error: null,
          isPending: true,
        });
        expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
          status: "valid",
          file: config,
          scripts: config.scripts,
        });
      } finally {
        registry.dispose();
        atomHooks.registry = null;
      }
    },
  );

  it.each([
    { phase: "connected", sessionError: "The session request timed out." },
    { phase: "offline", sessionError: null },
  ] as const)(
    "reports unavailable file access for $phase connections",
    ({ phase, sessionError }) => {
      authorizationMocks.phase = phase;
      authorizationMocks.sessionAtom = Atom.make(
        sessionError === null
          ? AsyncResult.initial()
          : AsyncResult.failure(Cause.fail(new Error(sessionError))),
      );
      const registry = AtomRegistry.make();
      atomHooks.registry = registry;
      projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
      try {
        const unavailable = {
          data: null,
          error: sessionError ?? "This environment is not connected.",
          isPending: false,
        };
        expect(useProjectFileQuery(environmentId, "/repo", "src/preview.ts")).toMatchObject(
          unavailable,
        );
        expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject(unavailable);
        expect(projectMocks.readFile).not.toHaveBeenCalled();
        expect(projectMocks.listEntries).not.toHaveBeenCalled();
      } finally {
        registry.dispose();
        atomHooks.registry = null;
      }
    },
  );

  it("leaves disabled file queries idle while the file grant loads", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useProjectFileQuery(environmentId, "/repo", "t3.json", false)).toMatchObject({
        data: null,
        error: null,
        isPending: false,
      });
      expect(useT3ProjectFileState(environmentId, null).status).toBe("missing");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("keeps cached contents while checking and only rereads a changed revision", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    let reads = 0;
    const readAtom = Atom.make(
      Effect.sync(() => {
        reads++;
        return { ...file(reads === 1 ? "cached" : "fresh"), revision: String(reads) };
      }),
    );
    const metadataAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    );
    const registry = appAtomRegistry;
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockImplementation(({ input }) =>
      input.metadataOnly ? metadataAtom : readAtom,
    );
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;
    let renderedContents: string | null = null;
    let unmountMetadata = () => {};

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(query.readError).toBeNull();
      renderedContents = query.data?.contents ?? null;
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:src/preview.ts",
      });
    };

    try {
      render(null);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      unmountMetadata = registry.mount(metadataAtom);
      expect(renderedContents).toBe("cached");
      requests.at(-1)!.resolve({ ...file(""), revision: "1", metadataOnly: true });
      await vi.waitFor(() => expect(registry.get(metadataAtom).waiting).toBe(false));
      await flushEffects();
      expect(reads).toBe(1);
      render("mutation-1");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      requests.at(-1)!.resolve({ ...file(""), revision: "1", metadataOnly: true });
      await vi.waitFor(() => expect(registry.get(metadataAtom).waiting).toBe(false));
      await flushEffects();
      expect(renderedContents).toBe("cached");
      render("mutation-2");
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      requests.at(-1)!.resolve({ ...file(""), revision: "2", metadataOnly: true });
      await vi.waitFor(() => expect(reads).toBe(2));
      render("mutation-2");
      expect(renderedContents).toBe("fresh");
    } finally {
      reactHooks.reset();
      unmountMetadata();
      unmount();
      atomHooks.registry = null;
      appAtomRegistry.reset();
    }
  });

  it("discards optimistic file contents before reopening from disk", async () => {
    const readAtom = Atom.make(Effect.succeed(file("fresh from disk")));
    const optimisticAtom = Atom.make({
      data: file("old editor snapshot"),
      confirmedAgainst: undefined,
    });
    const registry = appAtomRegistry;
    const unmountRead = registry.mount(readAtom);
    const unmountOptimistic = registry.mount(optimisticAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(optimisticAtom);
    atomHooks.registry = registry;
    let renderedContents: string | null = null;

    const render = () => {
      reactHooks.beginRender();
      const query = useProjectFileQuery(
        environmentId,
        "/repo",
        "src/preview.ts",
        true,
        true,
        false,
      );
      renderedContents = query.data?.contents ?? null;
    };

    try {
      render();
      await vi.waitFor(() => expect(registry.get(optimisticAtom)).toBeNull());
      render();

      expect(registry.get(optimisticAtom)).toBeNull();
      expect(renderedContents).toBe("fresh from disk");
    } finally {
      unmountOptimistic();
      unmountRead();
      atomHooks.registry = null;
      appAtomRegistry.reset();
    }
  });

  it("revalidates on activation without replacing an unchanged cached object", async () => {
    const snapshot = { ...file("# cached"), revision: "disk-1" };
    let reads = 0;
    let checks = 0;
    const readAtom = Atom.make(
      Effect.sync(() => {
        reads++;
        return snapshot;
      }),
    );
    const metadataAtom = Atom.make(
      Effect.sync(() => {
        checks++;
        return { ...snapshot, contents: "", metadataOnly: true };
      }),
    );
    const optimisticAtom = Atom.make(null);
    const registry = appAtomRegistry;
    const release = [readAtom, optimisticAtom].map((atom) => registry.mount(atom));
    projectMocks.readFile.mockImplementation(({ input }) =>
      input.metadataOnly ? metadataAtom : readAtom,
    );
    projectMocks.optimisticFile.mockReturnValue(optimisticAtom);
    atomHooks.registry = registry;
    const render = (active: boolean) => {
      reactHooks.beginRender();
      return useProjectFileQuery(
        environmentId,
        "/repo",
        "src/preview.ts",
        true,
        true,
        false,
        active,
      );
    };
    try {
      expect(render(true).data).toBe(snapshot);
      await vi.waitFor(() => expect(checks).toBeGreaterThan(0));
      const checksBeforeHiding = checks;
      expect(render(false).data).toBe(snapshot);
      await flushEffects();
      expect(checks).toBe(checksBeforeHiding);
      expect(render(true).data).toBe(snapshot);
      await vi.waitFor(() => expect(checks).toBeGreaterThan(checksBeforeHiding));
      expect(reads).toBe(1);
    } finally {
      reactHooks.reset();
      release.forEach((unmount) => unmount());
      atomHooks.registry = null;
      appAtomRegistry.reset();
    }
  });

  it("detects missed watcher changes with cached reads, and stops validation for hidden or dirty tabs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let snapshot = { ...file("before"), revision: "disk-1" };
    let reads = 0;
    let checks = 0;
    const readAtom = Atom.make(
      Effect.sync(() => {
        reads++;
        return snapshot;
      }),
    ).pipe(Atom.swr({ staleTime: Infinity, revalidateOnMount: true }), Atom.setIdleTTL(0));
    const metadataAtom = Atom.make(
      Effect.sync(() => {
        checks++;
        return { ...snapshot, contents: "", metadataOnly: true };
      }),
    ).pipe(Atom.swr({ staleTime: Infinity, revalidateOnMount: true }), Atom.setIdleTTL(0));
    const optimisticAtom = Atom.make(null);
    const registry = appAtomRegistry;
    const release = [readAtom, optimisticAtom].map((atom) => registry.mount(atom));
    projectMocks.readFile.mockImplementation(({ input }) =>
      input.metadataOnly ? metadataAtom : readAtom,
    );
    projectMocks.optimisticFile.mockReturnValue(optimisticAtom);
    atomHooks.registry = registry;
    const render = (active = true, dirty = false) => {
      reactHooks.beginRender();
      return useProjectFileQuery(
        environmentId,
        "/repo",
        "src/preview.ts",
        true,
        true,
        dirty,
        active,
      );
    };
    try {
      render();
      await vi.waitFor(() => expect(checks).toBeGreaterThan(0));
      const original = render().data;
      const initialChecks = checks;
      await vi.advanceTimersByTimeAsync(2000);
      expect(checks).toBe(initialChecks);
      await vi.advanceTimersByTimeAsync(8000);
      expect(reads).toBe(1);
      expect(render().data).toBe(original);
      // Same length; no watch event and no agent/workspace signal.
      snapshot = { ...file("after!"), revision: "disk-2" };
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(render().data?.contents).toBe("after!");
      render(false);
      expect(vi.getTimerCount()).toBe(0);
      const hiddenChecks = checks;
      snapshot = { ...file("third!"), revision: "disk-3" };
      await vi.advanceTimersByTimeAsync(20_000);
      expect(checks).toBe(hiddenChecks);
      render();
      await vi.waitFor(() => expect(reads).toBe(3));
      expect(render().data?.contents).toBe("third!");
      render(true, true);
      const dirtyChecks = checks;
      snapshot = { ...file("fourth"), revision: "disk-4" };
      await vi.advanceTimersByTimeAsync(20_000);
      expect(checks).toBe(dirtyChecks);
      expect(reads).toBe(3);
      render();
      await vi.waitFor(() => expect(reads).toBe(4));
      expect(render().data?.contents).toBe("fourth");
    } finally {
      reactHooks.reset();
      release.forEach((unmount) => unmount());
      atomHooks.registry = null;
      appAtomRegistry.reset();
      vi.useRealTimers();
    }
  });

  it.each(["preview.png", "preview.pdf"])(
    "refreshes %s metadata without reading binary contents",
    async (relativePath) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let revision = "disk-1";
      const metadataAtom = Atom.make(
        Effect.sync(() => ({ ...file(""), relativePath, revision, metadataOnly: true })),
      ).pipe(Atom.swr({ staleTime: Infinity, revalidateOnMount: true }));
      const optimisticAtom = Atom.make(null);
      const registry = appAtomRegistry;
      const release = [metadataAtom, optimisticAtom].map((atom) => registry.mount(atom));
      projectMocks.readFile.mockImplementation(({ input }) => {
        expect(input.metadataOnly).toBe(true);
        return metadataAtom;
      });
      projectMocks.optimisticFile.mockReturnValue(optimisticAtom);
      atomHooks.registry = registry;
      const render = () => {
        reactHooks.beginRender();
        return useProjectFileQuery(environmentId, "/repo", relativePath, true, true);
      };
      try {
        render();
        await flushEffects();
        revision = "disk-2";
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(render().data?.revision).toBe("disk-2"));
        expect(render().data?.contents).toBe("");
      } finally {
        reactHooks.reset();
        release.forEach((unmount) => unmount());
        atomHooks.registry = null;
        appAtomRegistry.reset();
        vi.useRealTimers();
      }
    },
  );

  it("ignores an outstanding disk check when the editor becomes dirty", async () => {
    let reads = 0;
    const request = deferred<ProjectReadFileResult>();
    const readAtom = Atom.make(
      Effect.sync(() => {
        reads++;
        return { ...file("disk"), revision: "1" };
      }),
    );
    const metadataAtom = Atom.make(Effect.promise(() => request.promise));
    const optimisticAtom = Atom.make({ data: file("local edit"), confirmedAgainst: undefined });
    const registry = appAtomRegistry;
    const release = [readAtom, optimisticAtom].map((atom) => registry.mount(atom));
    projectMocks.readFile.mockImplementation(({ input }) =>
      input.metadataOnly ? metadataAtom : readAtom,
    );
    projectMocks.optimisticFile.mockReturnValue(optimisticAtom);
    atomHooks.registry = registry;
    const render = (dirty: boolean) => {
      reactHooks.beginRender();
      return useProjectFileQuery(environmentId, "/repo", "src/preview.ts", true, true, dirty);
    };
    try {
      render(false);
      await flushEffects();
      render(true);
      request.resolve({ ...file(""), revision: "2", metadataOnly: true });
      await flushEffects();
      expect(render(true).data?.contents).toBe("local edit");
      expect(reads).toBe(1);
    } finally {
      reactHooks.reset();
      release.forEach((unmount) => unmount());
      atomHooks.registry = null;
      appAtomRegistry.reset();
    }
  });

  it("revalidates cached entries when a workspace mutation is observed after mounting", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectListEntriesResult>>> = [];
    const entriesAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectListEntriesResult>();
        requests.push(request);
        return request.promise;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(entriesAtom);
    projectMocks.listEntries.mockReturnValue(entriesAtom);
    atomHooks.registry = registry;
    let renderedPaths: readonly string[] = [];

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectEntriesQuery(environmentId, "/repo");
      renderedPaths = query.data?.entries.map((entry) => entry.path) ?? [];
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "files:environment-1:/repo",
      });
    };

    try {
      await flushEffects();
      expect(requests).toHaveLength(1);
      requests[0]!.resolve(projectEntries(["src/old.ts"]));
      await flushEffects();

      render("mutation-1");
      expect(renderedPaths).toEqual(["src/old.ts"]);
      await flushEffects();
      expect(requests).toHaveLength(2);

      requests[1]!.resolve(projectEntries(["src/new.ts"]));
      await flushEffects();
      render("mutation-1");
      expect(renderedPaths).toEqual(["src/new.ts"]);
      expect(requests).toHaveLength(2);
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("does not issue a file read for a disabled image preview", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    const readAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    );
    const registry = AtomRegistry.make();
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "preview.png", false);
      useWorkspaceMutationRefresh({
        enabled: false,
        mutationId: "mutation-1",
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:preview.png",
      });
      await flushEffects();

      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(query.readError).toBeNull();
      expect(requests).toHaveLength(0);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports a directory named like an image as not a file", async () => {
    const readAtom = Atom.make(
      Effect.fail(
        new ProjectReadFileError({
          cwd: "/repo",
          relativePath: "assets.png",
          failure: "path_not_file",
        }),
      ),
    );
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      await flushEffects();
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "assets.png");
      expect(query.isNotFile).toBe(true);
      expect(query.readError?.failure).toBe("path_not_file");
      expect(query.data).toBeNull();
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports a directory read as not a file", async () => {
    const readAtom = Atom.make(
      Effect.fail(
        new ProjectReadFileError({
          cwd: "/repo",
          relativePath: ".agents/skills",
          failure: "path_not_file",
        }),
      ),
    );
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      await flushEffects();
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", ".agents/skills");
      expect(query.isNotFile).toBe(true);
      expect(query.readError?.failure).toBe("path_not_file");
      expect(query.data).toBeNull();
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("retains decoded read failure context for the connected environment", async () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      cwd: "C:\\workspace",
      relativePath: "workspace/outline.md",
      failure: "operation_failed",
      operation: "realpath-target",
      operationPath: "C:\\workspace\\workspace\\outline.md",
      resolvedPath: "C:\\workspace\\workspace\\outline.md",
      message: "Failed to read workspace file.",
    });
    const readAtom = Atom.make(Effect.fail(error));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      await flushEffects();
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "C:\\workspace", "workspace/outline.md");
      expect(query.readError).toBe(error);
      expect(query.error).toBe(error.message);
      expect(query.isNotFile).toBe(false);
      expect(query.data).toBeNull();
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });
});
