// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/player", () => ({
  SongCardWithMenu: ({ title }: { title: string }) => <div>{title}</div>,
  playerEngine: {
    clearQueue: vi.fn(),
    playTrack: vi.fn(),
    playShuffled: vi.fn(),
  },
}));
vi.mock("@/features/player/store/playerStore", () => ({
  usePlayerStore: { getState: () => ({ setShuffle: vi.fn() }) },
}));

import { useDisableButtonFocus } from "@/features/navigation/hooks/useDisableButtonFocus";
import { useMixStore } from "../store/mixStore";
import MixPlaylistPage from "./MixPlaylistPage";

const track = (id: string): Track => ({
  id,
  title: `Song ${id}`,
  artists: "MCK",
  coverUrl: "",
  durationMs: 1000,
  playCount: 0,
});

// the app blurs every button the moment it gets focus, to hide focus rings
function Shell({ children }: { children: React.ReactNode }) {
  useDisableButtonFocus();
  return <>{children}</>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function open(ids: string[]) {
  useMixStore.setState({
    mixes: ids.map((id) => ({
      id,
      name: `Mix ${id}`,
      createdAt: 1,
      tracks: [track(id)],
    })),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <Shell>
        <MemoryRouter initialEntries={[`/library/mixes?id=${ids[0]}`]}>
          <Routes>
            <Route path="/library/mixes" element={<MixPlaylistPage />} />
            <Route path="/library" element={<div>library page</div>} />
          </Routes>
        </MemoryRouter>
      </Shell>,
    ),
  );
}

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

// a real press: the button takes focus (and the app blurs it), then clicks
const press = (target: HTMLButtonElement) => {
  act(() => target.focus()); // mouse down: React renders before the click
  act(() => target.click());
};

describe("MixPlaylistPage delete", () => {
  it("asks once, then deletes the mix and goes back to the library", () => {
    open(["a", "b"]);

    press(button("mix.delete")!);
    expect(useMixStore.getState().mixes).toHaveLength(2);
    expect(button("mix.delete_confirm")).toBeTruthy();

    press(button("mix.delete_confirm")!);

    expect(useMixStore.getState().mixes.map((m) => m.id)).toEqual(["b"]);
    expect(document.body.textContent).toContain("library page");
  });
});
