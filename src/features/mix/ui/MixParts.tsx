import { useEffect, useState } from "react";
import { Check2Fill, CloseLine } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { isLocalTrackId } from "@/shared/media/local";
import type { Track } from "@/shared/types";

function clock(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// every song of a mix in play order, so you can judge it before you keep it
export function MixTrackList({
  tracks,
  onRemove,
}: {
  tracks: Track[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-h-[280px] overflow-y-auto rounded-[10px] bg-black/[0.04] py-[4px] dark:bg-white/[0.05]">
      {tracks.map((track, index) => (
        <div
          key={track.id}
          className="group flex items-center gap-[8px] px-[10px] py-[4px] text-[13px]"
        >
          <span className="w-[22px] shrink-0 text-right text-text-tertiary">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-text-primary">{track.title}</div>
            <div className="truncate text-[12px] text-text-tertiary">
              {track.artists}
            </div>
          </div>
          {isLocalTrackId(track.id) && (
            <Check2Fill
              size={13}
              className="shrink-0 text-accent-primary"
              aria-label={t("common.downloaded")}
            />
          )}
          <span className="shrink-0 text-[12px] text-text-tertiary">
            {clock(track.durationMs)}
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(track.id)}
              aria-label={t("mix.remove_song")}
              title={t("mix.remove_song")}
              className="flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-[2px] text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary"
            >
              <CloseLine size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// a name that is edited in place and kept when the field loses focus
export function NameField({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit: (name: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== value) onCommit(name);
    else setDraft(value);
  };
  return (
    <input
      type="text"
      value={draft}
      maxLength={60}
      spellCheck={false}
      aria-label={t("mix.rename")}
      title={t("mix.rename")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={
        className ??
        "w-full min-w-0 rounded-[6px] border-0 bg-transparent px-[4px] py-[2px] text-[15px] font-semibold text-text-primary outline-none hover:bg-black/[0.05] focus:bg-black/[0.07] dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.1]"
      }
    />
  );
}
