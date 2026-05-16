import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export class AssetStore {
  constructor(assetDir) {
    this.assetDir = assetDir;
  }

  async saveImage({ bytes, mimeType = "image/png", metadata = {} }) {
    await fs.mkdir(this.assetDir, { recursive: true });
    const id = `img_${randomUUID()}`;
    const extension = MIME_TO_EXT[mimeType] || ".png";
    const filePath = path.join(this.assetDir, `${id}${extension}`);
    await fs.writeFile(filePath, bytes);

    const record = {
      id,
      filePath,
      mimeType,
      metadata,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(`${filePath}.json`, JSON.stringify(record, null, 2));
    return record;
  }

  async get(assetId) {
    const entries = await fs.readdir(this.assetDir).catch(() => []);
    const match = entries.find((entry) => entry.startsWith(`${assetId}.`) && !entry.endsWith(".json"));
    if (!match) {
      return null;
    }

    const filePath = path.join(this.assetDir, match);
    const metadataPath = `${filePath}.json`;
    const rawMetadata = await fs.readFile(metadataPath, "utf8").catch(() => null);
    if (rawMetadata) {
      return JSON.parse(rawMetadata);
    }

    return {
      id: assetId,
      filePath,
      mimeType: "application/octet-stream",
      metadata: {},
    };
  }
}
