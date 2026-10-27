import { useNavigate } from "react-router-dom";
import { useTranslation } from "@/languages";
import { useMixStore, type SavedMix } from "../store/mixStore";
import MixCover from "./MixCover";

const INTER = { fontFamily: "var(--font-inter), sans-serif" };

function MixCard({
  mix,
  viewMode,
}: {
  mix: SavedMix;
  viewMode: "grid" | "list";
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = () =>
    navigate(`/library/mixes?id=${encodeURIComponent(mix.id)}`);
  const count = t("common.songs", { count: mix.tracks.length });

  if (viewMode === "list") {
    return (
      <div
        onClick={open}
        className="flex w-full cursor-pointer select-none items-center gap-[16px] rounded-md p-[8px] transition-colors duration-150 ease-out hover:bg-border-alpha-14"
      >
        <div className="relative h-[48px] w-[48px] shrink-0 overflow-hidden rounded-md">
          <MixCover tracks={mix.tracks} />
        </div>
        <div className="flex min-w-0 flex-col gap-[2px]" style={INTER}>
          <h3 className="m-0 truncate text-[16px] leading-[1.2] font-[400] text-text-primary">
            {mix.name}
          </h3>
          <p className="m-0 truncate text-[15px] leading-[1.2] font-[350] text-text-secondary">
            {t("mix.title")} · {count}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={open}
      className="group flex cursor-pointer flex-col gap-[8px]"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-md">
        <MixCover tracks={mix.tracks} />
      </div>
      <div className="flex flex-col gap-[4px]" style={INTER}>
        <span className="truncate text-[14px] font-[500] text-text-primary">
          {mix.name}
        </span>
        <span className="truncate text-[13px] text-text-tertiary">
          {t("mix.title")} · {count}
        </span>
      </div>
    </div>
  );
}

// one card per saved mix, for the library's playlists
export function MixCards({ viewMode }: { viewMode: "grid" | "list" }) {
  const mixes = useMixStore((state) => state.mixes);
  return (
    <>
      {mixes.map((mix) => (
        <MixCard key={mix.id} mix={mix} viewMode={viewMode} />
      ))}
    </>
  );
}
