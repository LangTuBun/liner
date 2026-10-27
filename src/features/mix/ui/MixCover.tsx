import { Magic1Fill } from "@mingcute/react";
import CoverImage from "@/features/covers/ui/CoverImage";
import { cn } from "@/shared/lib";
import type { Track } from "@/shared/types";

// up to four different covers from the mix, like a streamed playlist
export default function MixCover({
  tracks,
  className,
}: {
  tracks: Track[];
  className?: string;
}) {
  const covers = [
    ...new Set(tracks.map((track) => track.coverUrl).filter(Boolean)),
  ].slice(0, 4);
  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-bg-panel",
        className,
      )}
    >
      {covers.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent-primary/40 to-bg-panel text-text-primary/70">
          <Magic1Fill size={28} />
        </div>
      ) : covers.length < 4 ? (
        <CoverImage
          src={covers[0]}
          alt=""
          fill
          sizes="256px"
          placeholder="empty"
          className="object-cover pointer-events-none"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
          {covers.map((cover) => (
            <div key={cover} className="relative">
              <CoverImage
                src={cover}
                alt=""
                fill
                sizes="128px"
                placeholder="empty"
                className="object-cover pointer-events-none"
                draggable={false}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
