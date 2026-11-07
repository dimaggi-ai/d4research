import { useAudioPlayerStatus } from "expo-audio";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { createAudioPlaybackSession } from "../../lib/audioSession";
import { usePlaybackAudioPlayer } from "../voice-input/usePlaybackAudioPlayer";

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioFilePreview(props: { uri: string; onRetry: () => void }) {
  const player = usePlaybackAudioPlayer(props.uri);
  const status = useAudioPlayerStatus(player);
  const [seekError, setSeekError] = useState(false);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const session = useMemo(
    () => createAudioPlaybackSession(player, false, setPlaybackRequested),
    [player],
  );
  // Video teardown deactivates the shared iOS session, which would stop this player.
  useMediaAudioSessionHold(playbackRequested || status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  // Stop the native player when video takes the audio session or playback finishes.
  useEffect(() => {
    if (fullscreenVideoOpen || status.didJustFinish || status.error) session.pause();
  }, [fullscreenVideoOpen, status.didJustFinish, status.error, session]);
  // Release this mounted viewer's native playback request on teardown.
  useEffect(() => () => session.pause(), [session]);
  const seek = (seconds: number) => {
    setSeekError(false);
    void player.seekTo(seconds).catch(() => setSeekError(true));
  };
  return (
    <View className="flex-1 items-center justify-center gap-5 p-6">
      <Text className="text-foreground-muted">
        {timestamp(status.currentTime)} / {timestamp(status.duration)}
      </Text>
      <View className="flex-row items-center gap-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.max(0, status.currentTime - 15))}
          className="p-4"
        >
          <Text className="text-foreground">−15s</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!status.isLoaded && !playbackRequested}
          onPress={() => {
            if (status.playing || session.requested) session.pause();
            else {
              setSeekError(false);
              void session
                .play(
                  status.didJustFinish || status.currentTime >= status.duration
                    ? () => player.seekTo(0)
                    : undefined,
                )
                .catch(() => setSeekError(true));
            }
          }}
          className="rounded-xl bg-subtle px-6 py-4"
        >
          <Text className="text-foreground">
            {playbackRequested || status.playing ? "Pause" : !status.isLoaded ? "Loading…" : "Play"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Forward 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.min(status.duration, status.currentTime + 15))}
          className="p-4"
        >
          <Text className="text-foreground">+15s</Text>
        </Pressable>
      </View>
      {status.error || seekError ? (
        <View className="items-center gap-3">
          <Text className="text-center text-foreground">
            This audio could not be played. Try again or save it to open in another app.
          </Text>
          <Pressable accessibilityRole="button" onPress={props.onRetry} className="p-3">
            <Text className="text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
