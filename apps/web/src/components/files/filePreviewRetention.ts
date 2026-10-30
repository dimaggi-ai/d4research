import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@d4research/shared/filePreview";

/** Text editors keep DOM/scroll/undo state. Media and live pages must stop when hidden. */
export function retainFilePreview(path: string, attachment: boolean): boolean {
  return (
    !attachment &&
    !isWorkspaceAudioPreviewPath(path) &&
    !isWorkspaceImagePreviewPath(path) &&
    !isWorkspaceVideoPreviewPath(path) &&
    !/\.(?:pdf|html?|svg)$/i.test(path)
  );
}
