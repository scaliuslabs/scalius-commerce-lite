import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { mediaVariantWidths } from "../src/generated/media-variants.gen.js";
import { canHaveRenditions, encodeLocalRenditions } from "../src/renditions.js";

async function imageFile(name: string, width: number, height: number, format: "jpeg" | "png", orientation?: number) {
  const directory = await mkdtemp(join(tmpdir(), "scalius-renditions-test-"));
  const path = join(directory, name);
  let pipeline = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  pipeline = format === "jpeg" ? pipeline.jpeg() : pipeline.png();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await writeFile(path, await pipeline.toBuffer());
  return path;
}

describe("local renditions", () => {
  it("encodes the whole ladder as WebP at the widths the API derives", async () => {
    const path = await imageFile("hero.jpg", 1000, 500, "jpeg");

    const renditions = await encodeLocalRenditions(path, "image/jpeg");

    expect(renditions).not.toBeNull();
    expect(renditions).toMatchObject({ width: 1000, height: 500 });
    expect(renditions!.files.map((file) => file.width)).toEqual(mediaVariantWidths(1000));
    for (const file of renditions!.files) {
      const info = await sharp(file.bytes).metadata();
      expect(info.format).toBe("webp");
      expect(info.width).toBe(file.width);
    }
  });

  it("reports the size after EXIF orientation, like the browser pipeline", async () => {
    const path = await imageFile("phone.jpg", 600, 300, "jpeg", 6);

    const renditions = await encodeLocalRenditions(path, "image/jpeg");

    expect(renditions).toMatchObject({ width: 300, height: 600 });
    expect(renditions!.files.map((file) => file.width)).toEqual(mediaVariantWidths(300));
    const master = renditions!.files.at(-1)!;
    expect(await sharp(master.bytes).metadata()).toMatchObject({ width: 300, height: 600 });
  });

  it("caps the master at 2,400 px and never enlarges", async () => {
    const path = await imageFile("poster.png", 3000, 100, "png");

    const renditions = await encodeLocalRenditions(path, "image/png");

    expect(renditions!.files.at(-1)!.width).toBe(2400);
    expect(renditions!.files.map((file) => file.width)).toEqual(mediaVariantWidths(3000));
  });

  it("leaves GIFs, videos and undecodable files pending", async () => {
    expect(canHaveRenditions("image/gif")).toBe(false);
    expect(canHaveRenditions("video/mp4")).toBe(false);
    expect(await encodeLocalRenditions("/missing.gif", "image/gif")).toBeNull();
    const directory = await mkdtemp(join(tmpdir(), "scalius-renditions-test-"));
    const broken = join(directory, "broken.jpg");
    await writeFile(broken, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(await encodeLocalRenditions(broken, "image/jpeg")).toBeNull();
  });
});
