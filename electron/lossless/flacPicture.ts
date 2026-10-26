import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const BLOCK_PICTURE = 6;
const PICTURE_FRONT_COVER = 3;
const MAX_BLOCK_BYTES = 0xffffff;

interface MetadataBlock {
  type: number;
  data: Buffer;
}

export interface FlacPicture {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export async function readMetadata(
  filePath: string,
): Promise<{ blocks: MetadataBlock[]; audioStart: number }> {
  const handle = await fsp.open(filePath, "r");
  try {
    const read = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      if (bytesRead !== length) throw new Error("truncated flac header");
      return buf;
    };
    if ((await read(0, 4)).toString("latin1") !== "fLaC")
      throw new Error("not a flac file");
    const blocks: MetadataBlock[] = [];
    let offset = 4;
    for (;;) {
      const header = await read(offset, 4);
      const last = (header[0] & 0x80) !== 0;
      const type = header[0] & 0x7f;
      const length = header.readUIntBE(1, 3);
      blocks.push({ type, data: await read(offset + 4, length) });
      offset += 4 + length;
      if (last) break;
    }
    if (blocks[0]?.type !== 0) throw new Error("flac streaminfo missing");
    return { blocks, audioStart: offset };
  } finally {
    await handle.close();
  }
}

function pictureType(block: MetadataBlock): number {
  return block.data.length >= 4 ? block.data.readUInt32BE(0) : -1;
}

export function encodePictureBlock(picture: FlacPicture): Buffer {
  const mime = Buffer.from(picture.mimeType, "latin1");
  const description = Buffer.from("Cover (front)", "utf8");
  const head = Buffer.alloc(8 + mime.length);
  head.writeUInt32BE(PICTURE_FRONT_COVER, 0);
  head.writeUInt32BE(mime.length, 4);
  mime.copy(head, 8);
  const mid = Buffer.alloc(4);
  mid.writeUInt32BE(description.length, 0);
  const tail = Buffer.alloc(20);
  tail.writeUInt32BE(picture.width, 0);
  tail.writeUInt32BE(picture.height, 4);
  tail.writeUInt32BE(24, 8);
  tail.writeUInt32BE(0, 12);
  tail.writeUInt32BE(picture.data.length, 16);
  return Buffer.concat([head, mid, description, tail, picture.data]);
}

function encodeMetadata(blocks: MetadataBlock[]): Buffer {
  const parts: Buffer[] = [Buffer.from("fLaC", "latin1")];
  blocks.forEach((block, i) => {
    const header = Buffer.alloc(4);
    header[0] = (i === blocks.length - 1 ? 0x80 : 0) | block.type;
    header.writeUIntBE(block.data.length, 1, 3);
    parts.push(header, block.data);
  });
  return Buffer.concat(parts);
}

export async function hasFrontCover(filePath: string): Promise<boolean> {
  const { blocks } = await readMetadata(filePath);
  return blocks.some(
    (b) => b.type === BLOCK_PICTURE && pictureType(b) === PICTURE_FRONT_COVER,
  );
}

// replaces the front cover in the metadata and copies the audio frames byte
// for byte, so the decoded audio cannot change
export async function embedFlacCover(
  filePath: string,
  picture: FlacPicture,
): Promise<void> {
  const block = encodePictureBlock(picture);
  if (block.length > MAX_BLOCK_BYTES) throw new Error("cover is too large");
  const { blocks, audioStart } = await readMetadata(filePath);
  const kept = blocks.filter(
    (b) =>
      !(b.type === BLOCK_PICTURE && pictureType(b) === PICTURE_FRONT_COVER),
  );
  // streaminfo stays first; the picture goes right after it
  kept.splice(1, 0, { type: BLOCK_PICTURE, data: block });
  const temp = `${filePath}.cover.tmp`;
  try {
    const out = fs.createWriteStream(temp);
    out.write(encodeMetadata(kept));
    await pipeline(fs.createReadStream(filePath, { start: audioStart }), out);
    const [before, after] = await Promise.all([
      fsp.stat(filePath),
      fsp.stat(temp),
    ]);
    const header = encodeMetadata(kept).length;
    if (after.size - header !== before.size - audioStart)
      throw new Error("audio frames were not copied whole");
    await fsp.rename(temp, filePath);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}
