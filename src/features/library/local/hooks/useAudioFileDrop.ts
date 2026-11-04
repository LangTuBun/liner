import { useEffect, useRef, useState } from "react";

const AUDIO_EXTENSION = /\.(mp3|flac|m4a|aac|ogg|opus|wav|webm|dsf)$/i;

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

const draggedFileCount = (event: DragEvent) =>
  Array.from(event.dataTransfer?.items ?? []).filter(
    (item) => item.kind === "file",
  ).length;

export function isAudioFile(file: File): boolean {
  return AUDIO_EXTENSION.test(file.name);
}

export function useAudioFileDrop(onDrop: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const depth = useRef(0);
  const onDropRef = useRef(onDrop);

  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setFileCount(draggedFileCount(event));
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      // a dropped folder arrives as an extensionless File; the main process
      // expands it, so keep it next to the audio files
      const folders = new Set(
        Array.from(event.dataTransfer?.items ?? [])
          .map((item) => item.webkitGetAsEntry?.())
          .filter((entry) => entry?.isDirectory)
          .map((entry) => entry!.name),
      );
      onDropRef.current(
        Array.from(event.dataTransfer?.files ?? []).filter(
          (file) => isAudioFile(file) || folders.has(file.name),
        ),
      );
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return { dragging, fileCount };
}
