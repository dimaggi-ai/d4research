import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@d4research/shared/HostProcess";

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@d4research/desktop/electron/ElectronSafeStorage") {}

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  // Local fork builds are ad-hoc signed, so macOS treats every rebuild as a different app and asks
  // for the Safe Storage Keychain secret again. Keep OS-keychain storage off unless the process
  // explicitly opts in. The connection catalog has its own local-file encryption fallback;
  // legacy credential consumers may keep secrets in memory only.
  const keychainSecretStorageEnabled = yield* Config.Boolean(
    "T3CODE_ENABLE_SAFE_STORAGE_KEYCHAIN",
  ).pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );

  return ElectronSafeStorage.of({
    isEncryptionAvailable: keychainSecretStorageEnabled
      ? Effect.try({
          try: () => Electron.safeStorage.isEncryptionAvailable(),
          catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
        })
      : Effect.succeed(false),
    encryptString: Effect.fn("ElectronSafeStorage.encryptString")(function (value) {
      return Effect.try({
        try: () => Electron.safeStorage.encryptString(value),
        catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
      });
    }),
    decryptString: Effect.fn("ElectronSafeStorage.decryptString")(function (value) {
      return Effect.try({
        try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
        catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
      });
    }),
    selectedStorageBackend: Effect.sync(() => {
      if (platform !== "linux") {
        return Option.none();
      }
      try {
        return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
