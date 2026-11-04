import { useEffect, useMemo, useState } from "react";
import {
  DialogActions,
  DialogButton,
  DialogHeader,
  useToast,
} from "@/shared/ui";
import Dialog from "@/shared/ui/Dialog";
import { useTranslation } from "@/languages";
import type { LocalTrackRecord, TidyGroup } from "@/shared/media/local";
import { useLocalLibraryStore } from "../store/localLibraryStore";

interface TidyDuplicatesDialogProps {
  open: boolean;
  onClose: () => void;
}

function describe(record: LocalTrackRecord): string {
  const kind = record.mimeType.split("/")[1] ?? "";
  const detail = record.lossless
    ? [
        record.bitDepth ? `${record.bitDepth}-bit` : "",
        record.sampleRate ? `${record.sampleRate / 1000} kHz` : "",
      ]
        .filter(Boolean)
        .join(" ")
    : record.bitrate
      ? `${Math.round(record.bitrate / 1000)} kbps`
      : "";
  return [kind.toUpperCase(), detail, record.source ?? ""]
    .filter(Boolean)
    .join(" · ");
}

export default function TidyDuplicatesDialog({
  open,
  onClose,
}: TidyDuplicatesDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const tidyPlan = useLocalLibraryStore((state) => state.tidyPlan);
  const tidyApply = useLocalLibraryStore((state) => state.tidyApply);
  const [groups, setGroups] = useState<TidyGroup[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setGroups(null);
    void tidyPlan()
      .then((plan) => {
        if (!active) return;
        setGroups(plan);
        // only the sure ones start ticked; a different artist spelling or a
        // longer video waits for the owner
        setChosen(
          new Set(
            plan.flatMap((group) =>
              group.losers
                .filter((loser) => loser.certainty === "sure")
                .map((loser) => loser.record.id),
            ),
          ),
        );
      })
      .catch(() => active && setGroups([]));
    return () => {
      active = false;
    };
  }, [open, tidyPlan]);

  const count = useMemo(() => chosen.size, [chosen]);

  const flip = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const confirm = async () => {
    setWorking(true);
    try {
      const removed = await tidyApply([...chosen]);
      toast(t("library.local.tidy_done", { count: removed }), "info");
      onClose();
    } catch {
      toast(t("settings.cache.local_cache.error"), "error");
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!next && !working ? onClose() : undefined)}
      maxWidth={560}
    >
      <div className="flex flex-col px-[20px] pb-[20px]">
        <DialogHeader
          className="mb-[12px]"
          title={t("library.local.tidy_title")}
          description={t("library.local.tidy_desc")}
        />
        <div className="mb-[16px] flex max-h-[52vh] flex-col gap-[14px] overflow-y-auto">
          {groups === null ? (
            <p className="m-0 text-body text-text-tertiary">
              {t("library.local.tidy_scanning")}
            </p>
          ) : groups.length === 0 ? (
            <p className="m-0 text-body text-text-tertiary">
              {t("library.local.tidy_none")}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.winner.id} className="flex flex-col gap-[4px]">
                <p className="m-0 truncate text-body font-[500] text-text-primary">
                  {group.winner.title} · {group.winner.artist}
                </p>
                <p className="m-0 text-[12.5px] text-text-tertiary">
                  {t("library.local.tidy_keep")}: {describe(group.winner)}
                </p>
                {group.losers.map((loser) => (
                  <label
                    key={loser.record.id}
                    className="flex cursor-pointer items-start gap-[8px] text-[13px] text-text-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(loser.record.id)}
                      onChange={() => flip(loser.record.id)}
                      disabled={working}
                      className="mt-[3px]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {loser.record.artist} · {describe(loser.record)}
                      </span>
                      <span className="block text-[12px] text-text-tertiary">
                        {t(`library.local.tidy_reason_${loser.reason}`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
        <DialogActions>
          <DialogButton onClick={onClose} disabled={working}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            variant="danger"
            onClick={() => void confirm()}
            loading={working}
            disabled={count === 0}
          >
            {t("library.local.tidy_remove", { count })}
          </DialogButton>
        </DialogActions>
      </div>
    </Dialog>
  );
}
