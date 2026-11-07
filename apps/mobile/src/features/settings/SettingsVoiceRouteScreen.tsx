import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform, Pressable, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import {
  isMicrophoneDevice,
  type MicrophoneEntry,
  type MicrophoneKind,
  microphoneEntryKey,
} from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import {
  chooseVoiceDestination,
  voiceConnectionAtom,
  voiceGrantAtom,
  voiceSpeechStatusAtom,
  hasEnvironmentVoiceCapture,
} from "../voice-input/voiceDestination";
import { VoiceModelSection } from "./VoiceModelSection";
import type { EnvironmentId } from "@d4research/contracts";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  deviceMicrophoneOrder,
  localVoiceTranscriberAtom,
} from "../voice-input/VoiceInputProvider";

const REMOVE_SIZE = 20;

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>("checking");
  const apply = useCallback(
    (response: { readonly granted: boolean; readonly canAskAgain: boolean }) =>
      setPermission(response.granted ? "granted" : response.canAskAgain ? "ask" : "denied"),
    [],
  );
  const refresh = useCallback(
    () => void getRecordingPermissionsAsync().then(apply, () => setPermission("ask")),
    [apply],
  );
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const request = useCallback(
    () => void requestRecordingPermissionsAsync().then(apply, refresh),
    [apply, refresh],
  );
  return { permission, request };
}

const KINDS: Record<
  MicrophoneKind,
  {
    readonly label: string;
    readonly row: string;
    readonly rowDescription: string;
    readonly icon: AppSymbolName;
  }
> = {
  wired: {
    label: "Wired",
    row: "Other wired",
    rowDescription: "Headsets and USB microphones not listed here",
    icon: "cable.connector",
  },
  bluetooth: {
    label: "Bluetooth",
    row: "Other Bluetooth",
    rowDescription:
      Platform.OS === "android"
        ? "Earbuds, headsets, and cars, including Android Auto, not listed here"
        : "AirPods, headsets, and cars not listed here",
    icon: "headphones",
  },
  builtIn: {
    label: "Built-in",
    row: "Built-in microphone",
    rowDescription: "The microphone on this device",
    icon: "iphone",
  },
  carPlay: {
    label: "CarPlay",
    row: "CarPlay",
    rowDescription: "The car’s microphone",
    icon: "car",
  },
};

const UNAVAILABLE_EXPLANATION =
  Platform.OS === "android"
    ? "Dictation on this device needs Android 12 or later and Google speech services that support your language. Your keyboard’s voice typing is separate."
    : "Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.";

function saveDestination(id: EnvironmentId | null) {
  try {
    chooseVoiceDestination(id);
  } catch {
    Dialog.alert(
      "Could not save transcription choice",
      "Dictation on an environment is off for this session. Save again before closing the app, or your previous choice may return when it restarts.",
    );
  }
}

function EnvironmentChoice({
  environment,
  selected,
}: {
  environment: EnvironmentPresentation;
  selected: boolean;
}) {
  const usable = useAtomValue(voiceConnectionAtom(environment.environmentId)) !== null;
  const status = AsyncResult.getOrElse(
    useAtomValue(voiceSpeechStatusAtom(environment.environmentId)),
    () => null,
  );
  return (
    <ListChoiceRow
      label={environment.label}
      selected={selected}
      disabled={!usable}
      description={
        !usable
          ? environment.connection.phase !== "connected"
            ? "Not connected"
            : "Transcription unavailable"
          : status?.supported === false
            ? status.reason
            : status?.state === "missing-model"
              ? "No transcription model installed"
              : (environment.displayUrl ?? "Send finished recordings to this environment.")
      }
      separated
      onPress={() => {
        if (!selected)
          Dialog.confirm({
            title: `Send microphone audio to ${environment.label}?`,
            message: `Finished recordings will be sent to ${environment.displayUrl ?? environment.label} for transcription. You can switch back to This device at any time.`,
            confirmText: "Use environment",
            onConfirm: () => saveDestination(environment.environmentId),
          });
      }}
    />
  );
}

export function SettingsVoiceRouteScreen() {
  const transcriber = useAtomValue(localVoiceTranscriberAtom);
  const grant = useAtomValue(voiceGrantAtom);
  const { environments, isReady } = useEnvironments();
  const grantEnvironment = grant
    ? environments.find(
        (environment) => environment.environmentId === grant.destination.environmentId,
      )
    : undefined;
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const entries = deviceMicrophoneOrder(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.microphones : undefined,
  );
  const hasDevices = entries.some(isMicrophoneDevice);
  const { permission, request: requestPermission } = useMicrophonePermission();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<{ readonly key: string; readonly translation: number } | null>(
    null,
  );
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored order, so a device recorded meanwhile is kept.
  const move = (key: string, steps: number) =>
    savePreferences({
      transform: (current) => {
        const next = [...deviceMicrophoneOrder(current.microphones)];
        const from = next.findIndex((entry) => microphoneEntryKey(entry) === key);
        const to = Math.min(next.length - 1, Math.max(0, from + steps));
        if (from === -1 || from === to) return {};
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { microphones: next };
      },
    });
  const forget = (key: string) =>
    savePreferences({
      transform: (current) => ({
        microphones: deviceMicrophoneOrder(current.microphones).filter(
          (entry) => microphoneEntryKey(entry) !== key,
        ),
      }),
    });
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(entries.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) -
        from;

  const dragFrom =
    drag === null ? -1 : entries.findIndex((entry) => microphoneEntryKey(entry) === drag.key);
  const dragTo = drag === null ? -1 : dragFrom + dropSteps(dragFrom, drag.translation);

  return (
    <SettingsScreen title="Voice">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Transcribe on">
          <ListChoiceRow
            label="This device"
            description="Audio stays on this device and is transcribed here."
            selected={!grant}
            onPress={() => saveDestination(null)}
          />
          {hasEnvironmentVoiceCapture &&
            environments.map((environment) => (
              <EnvironmentChoice
                key={environment.environmentId}
                environment={environment}
                selected={
                  grant?.destination.kind === "environment" &&
                  grant.destination.environmentId === environment.environmentId
                }
              />
            ))}
          {isReady && grant && !grantEnvironment ? (
            <ListChoiceRow
              label="Previously selected environment"
              description="No longer paired"
              separated
              selected
              disabled
              onPress={() => {}}
            />
          ) : null}
        </SettingsSection>
        {grantEnvironment && grant?.destination.kind === "environment" ? (
          <VoiceModelSection
            environmentId={grantEnvironment.environmentId}
            label={grantEnvironment.label}
          />
        ) : null}
        {!grant && transcriber === null ? (
          <Text className="px-2 text-sm text-foreground-muted">{UNAVAILABLE_EXPLANATION}</Text>
        ) : null}
        {permission === "ask" || permission === "denied" ? (
          <>
            <SettingsSection title="Microphone access">
              <SettingsActionRow
                icon="mic"
                label={permission === "ask" ? "Allow microphone access" : "Open Settings"}
                onPress={
                  permission === "ask" ? requestPermission : () => void Linking.openSettings()
                }
              />
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              {permission === "ask"
                ? "Voice input needs microphone access before it can record or list your microphones."
                : "Microphone access is off for d4research. Turn it on in Settings to use voice input."}
            </Text>
          </>
        ) : null}
        <SettingsSection
          title="Preferred order"
          trailing={
            hasDevices ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setEditing((value) => !value)}
                className="px-2 py-1 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  {editing ? "Done" : "Edit"}
                </Text>
              </Pressable>
            ) : undefined
          }
        >
          {entries.map((entry, index) => {
            const key = microphoneEntryKey(entry);
            const shift =
              dragFrom === -1 || index === dragFrom
                ? 0
                : dragFrom < dragTo && index > dragFrom && index <= dragTo
                  ? -rowHeight
                  : dragFrom > dragTo && index < dragFrom && index >= dragTo
                    ? rowHeight
                    : 0;
            return (
              <MicrophoneRow
                key={`${key}:${drops}`}
                entry={entry}
                position={index + 1}
                count={entries.length}
                reorderable={ready}
                editing={editing && hasDevices}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                onHeight={setRowHeight}
                onDragStart={() => setDrag({ key, translation: 0 })}
                onDragMove={(translation) => setDrag({ key, translation })}
                onDragEnd={(translation, cancelled) => {
                  setDrag(null);
                  setDrops((count) => count + 1);
                  if (!cancelled) move(key, dropSteps(index, translation));
                }}
                onStep={(direction) => move(key, direction === "up" ? -1 : 1)}
                onForget={isMicrophoneDevice(entry) ? () => forget(key) : undefined}
              />
            );
          })}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Voice input records from the first connected microphone in this list. Wired and Bluetooth
          devices are added by name after you use voice input with them connected; until then, the
          Other row ranks them.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}

function MicrophoneRow(props: {
  readonly entry: MicrophoneEntry;
  readonly position: number;
  readonly count: number;
  readonly reorderable: boolean;
  readonly editing: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onForget: (() => void) | undefined;
}) {
  const { lifted, offset, entry } = props;
  const kind = KINDS[entry.kind];
  const title = isMicrophoneDevice(entry) ? entry.name : kind.row;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        "flex-row items-center gap-4 pl-4",
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
        !props.reorderable && "pr-4",
      )}
    >
      {props.editing && props.onForget ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Forget ${title}`}
          hitSlop={8}
          onPress={props.onForget}
          className="active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={REMOVE_SIZE}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : props.editing ? (
        <View style={{ width: REMOVE_SIZE }} />
      ) : null}
      <View
        accessible
        accessibilityLabel={`${title}, ${kind.label}, ${props.position} of ${props.count}`}
        className="min-w-0 flex-1 flex-row items-center gap-4 py-4"
      >
        <SymbolView
          name={kind.icon}
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-lg text-foreground">
            {title}
          </Text>
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {isMicrophoneDevice(entry) ? kind.label : kind.rowDescription}
          </Text>
        </View>
      </View>
      {props.reorderable ? (
        <SettingsDragHandle
          title={title}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      ) : null}
    </Reanimated.View>
  );
}
