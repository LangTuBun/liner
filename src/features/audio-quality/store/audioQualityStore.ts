import { create } from "zustand";

interface AudioQualityState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useAudioQualityStore = create<AudioQualityState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
