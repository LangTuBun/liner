import { nativeImage } from "electron";
import { MAX_COVER_BYTES, MAX_COVER_EDGE } from "../lossless/query.js";

export interface ShrunkPicture {
  data: Buffer;
  width: number;
  height: number;
}

// null when the picture is already small enough or can't be made smaller
export function shrinkPicture(data: Buffer): ShrunkPicture | null {
  try {
    const image = nativeImage.createFromBuffer(data);
    const { width, height } = image.getSize();
    if (
      !width ||
      !height ||
      (width <= MAX_COVER_EDGE &&
        height <= MAX_COVER_EDGE &&
        data.length <= MAX_COVER_BYTES)
    )
      return null;
    const scale = Math.min(1, MAX_COVER_EDGE / Math.max(width, height));
    const resized =
      scale < 1
        ? image.resize({
            width: Math.round(width * scale),
            height: Math.round(height * scale),
            quality: "best",
          })
        : image;
    const out = resized.toJPEG(85);
    if (out.length === 0 || out.length >= data.length) return null;
    return { data: out, ...resized.getSize() };
  } catch {
    return null;
  }
}
