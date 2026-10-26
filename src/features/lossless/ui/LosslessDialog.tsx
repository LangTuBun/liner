import { useEffect, useMemo, useState } from "react";
import { CloseLine } from "@mingcute/react";
import {
  Dialog,
  DialogActions,
  DialogButton,
  DialogHeader,
  TextInput,
  ToggleSwitch,
} from "@/shared/ui";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib/utils";
import {
  ipcErrorMessage,
  isFinishedJob,
  useLosslessStore,
  type LosslessJob,
} from "../store/losslessStore";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;
const card =
  "flex flex-col gap-[10px] rounded-[12px] bg-black/[0.04] p-[14px] dark:bg-white/[0.08]";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[12px] font-[500] text-text-tertiary" style={font}>
      {children}
    </span>
  );
}

function formatQuality(job: LosslessJob): string {
  const parts: string[] = [];
  if (job.codec) parts.push(job.codec.split(/\s/)[0].toUpperCase());
  if (job.bitDepth) parts.push(`${job.bitDepth}-bit`);
  if (job.sampleRate) {
    const k = job.sampleRate / 1000;
    parts.push(`${Number.isInteger(k) ? k : k.toFixed(1)} kHz`);
  }
  return parts.join(" · ");
}

function JobRow({ job }: { job: LosslessJob }) {
  const { t } = useTranslation();
  const cancel = useLosslessStore((s) => s.cancel);
  const active = !isFinishedJob(job);
  const quality = formatQuality(job);

  let status: string;
  if (job.state === "downloading")
    status = t("lossless.state.downloading", { percent: job.progress });
  else if (job.state === "done") {
    const extra = [
      quality,
      job.hiRes === "hires"
        ? t("lossless.hires.verified")
        : job.hiRes === "upsampled"
          ? t("lossless.hires.upsampled")
          : "",
      job.coverSize ? t("lossless.cover", { size: job.coverSize }) : "",
    ].filter(Boolean);
    status = [t("lossless.state.done"), ...extra].join(" · ");
  } else if (
    job.state === "failed" ||
    job.state === "skipped" ||
    job.state === "cancelled"
  )
    status = job.error || t(`lossless.state.${job.state}`);
  else status = t(`lossless.state.${job.state}`);

  return (
    <div className="flex items-center gap-[12px] py-[8px]">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span
          className="truncate text-[14px] font-[500] text-text-primary"
          style={font}
        >
          {job.title}
        </span>
        <span
          className={cn(
            "truncate text-[12.5px]",
            job.state === "failed" || job.hiRes === "upsampled"
              ? "text-accent-warning"
              : "text-text-tertiary",
          )}
          style={font}
        >
          {[job.artist, status].filter(Boolean).join(" · ")}
        </span>
        {job.state === "downloading" ? (
          <div className="mt-[3px] h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.1]">
            <div
              className="h-full rounded-full bg-text-primary/70 transition-[width] duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        ) : null}
      </div>
      {active ? (
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={() => void cancel(job.id)}
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-black/[0.06] hover:text-text-primary dark:hover:bg-white/[0.1]"
        >
          <CloseLine size={16} />
        </button>
      ) : null}
    </div>
  );
}

function SetupSection() {
  const { t } = useTranslation();
  const status = useLosslessStore((s) => s.snapshot?.status);
  const install = useLosslessStore((s) => s.install);
  const setAccount = useLosslessStore((s) => s.setAccount);
  const clearAccount = useLosslessStore((s) => s.clearAccount);
  const preferHiRes = useLosslessStore((s) => s.preferHiRes);
  const setPreferHiRes = useLosslessStore((s) => s.setPreferHiRes);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!status) return null;
  const { install: tool } = status;

  const saveAccount = async () => {
    setSaving(true);
    setError("");
    try {
      await setAccount(username.trim(), password);
      setPassword("");
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className={card}>
        <SectionTitle>{t("lossless.downloader")}</SectionTitle>
        <div className="flex items-center justify-between gap-[12px]">
          <span
            className="text-[13px] leading-[1.45] text-text-secondary"
            style={font}
          >
            {!tool.supported
              ? t("lossless.install.unsupported")
              : tool.installed
                ? t("lossless.install.ready", { version: tool.version })
                : tool.status === "downloading"
                  ? t("lossless.install.downloading", { percent: tool.percent })
                  : tool.status === "error"
                    ? t("lossless.install.error", { error: tool.error })
                    : t("lossless.install.needed")}
          </span>
          {tool.supported && !tool.installed ? (
            <DialogButton
              variant="primary"
              className="!h-[36px] !flex-none"
              loading={tool.status === "downloading"}
              onClick={() => void install()}
            >
              {t("lossless.install.button")}
            </DialogButton>
          ) : null}
        </div>
      </div>

      <div className={card}>
        <SectionTitle>{t("lossless.account.title")}</SectionTitle>
        {!status.secureStorage ? (
          <span className="text-[13px] text-accent-warning" style={font}>
            {t("lossless.account.no_secure_storage")}
          </span>
        ) : status.configured && status.username ? (
          <div className="flex items-center justify-between gap-[12px]">
            <span className="text-[13px] text-text-secondary" style={font}>
              {t("lossless.account.signed_in", { name: status.username })}
            </span>
            <DialogButton
              className="!h-[36px] !flex-none"
              onClick={() => void clearAccount()}
            >
              {t("lossless.account.sign_out")}
            </DialogButton>
          </div>
        ) : status.mock ? (
          <span className="text-[13px] text-text-secondary" style={font}>
            {t("lossless.account.mock")}
          </span>
        ) : (
          <form
            className="flex flex-col gap-[8px]"
            onSubmit={(e) => {
              e.preventDefault();
              void saveAccount();
            }}
          >
            <span
              className="text-[12.5px] leading-[1.45] text-text-tertiary"
              style={font}
            >
              {t("lossless.account.hint")}
            </span>
            <div className="flex gap-[8px]">
              <TextInput
                size="sm"
                autoComplete="off"
                placeholder={t("lossless.account.username")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <TextInput
                size="sm"
                type="password"
                autoComplete="off"
                placeholder={t("lossless.account.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <span className="text-[12.5px] text-accent-warning" style={font}>
                {error}
              </span>
            ) : null}
            <DialogActions>
              <DialogButton
                type="submit"
                variant="primary"
                className="!h-[36px]"
                loading={saving}
                disabled={!username.trim() || !password}
              >
                {t("lossless.account.save")}
              </DialogButton>
            </DialogActions>
          </form>
        )}
      </div>

      <div
        className={cn(card, "flex-row items-center justify-between gap-[12px]")}
      >
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span
            className="text-[14px] font-[500] text-text-primary"
            style={font}
          >
            {t("lossless.prefer_hires.title")}
          </span>
          <span
            className="text-[12.5px] leading-[1.45] text-text-tertiary"
            style={font}
          >
            {t("lossless.prefer_hires.description")}
          </span>
        </div>
        <ToggleSwitch checked={preferHiRes} onChange={setPreferHiRes} />
      </div>
    </>
  );
}

export function LosslessDialog() {
  const { t } = useTranslation();
  const open = useLosslessStore((s) => s.dialogOpen);
  const setOpen = useLosslessStore((s) => s.setDialogOpen);
  const jobs = useLosslessStore((s) => s.snapshot?.jobs);
  const refresh = useLosslessStore((s) => s.refresh);
  const clearFinished = useLosslessStore((s) => s.clearFinished);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const list = useMemo(() => jobs ?? [], [jobs]);
  const hasFinished = list.some(isFinishedJob);

  return (
    <Dialog open={open} onOpenChange={setOpen} maxWidth={560}>
      <div className="flex flex-col gap-[12px] px-[20px] pb-[20px]">
        <DialogHeader
          title={t("lossless.title")}
          description={t("lossless.description")}
        />
        <SetupSection />
        <div className={card}>
          <div className="flex items-center justify-between gap-[12px]">
            <SectionTitle>
              {t("lossless.downloads", { count: list.length })}
            </SectionTitle>
            {hasFinished ? (
              <button
                type="button"
                onClick={() => void clearFinished()}
                className="text-[12px] font-[500] text-text-tertiary hover:text-text-primary"
                style={font}
              >
                {t("lossless.clear_finished")}
              </button>
            ) : null}
          </div>
          {list.length === 0 ? (
            <span
              className="text-[13px] leading-[1.45] text-text-tertiary"
              style={font}
            >
              {t("lossless.empty")}
            </span>
          ) : (
            <div className="-my-[4px] flex max-h-[300px] flex-col divide-y divide-black/[0.05] overflow-y-auto dark:divide-white/[0.06]">
              {list.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>
        <span
          className="text-[11.5px] leading-[1.45] text-text-tertiary"
          style={font}
        >
          {t("lossless.legal")}
        </span>
      </div>
    </Dialog>
  );
}

// keeps download progress, toasts and the hi-res check running while the dialog is closed
export function LosslessBridge() {
  const init = useLosslessStore((s) => s.init);
  useEffect(() => init(), [init]);
  return null;
}
