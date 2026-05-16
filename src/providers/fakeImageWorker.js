const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

export class FakeImageWorker {
  constructor({ id = "fake-image", enabled = true } = {}) {
    this.id = id;
    this.enabled = enabled;
  }

  async health() {
    return {
      id: this.id,
      status: this.enabled ? "ready" : "disabled",
      capabilities: ["image_generate"],
    };
  }

  async generateImage({ prompt }) {
    return {
      bytes: ONE_BY_ONE_PNG,
      mimeType: "image/png",
      providerMetadata: {
        worker: this.id,
        prompt,
        fake: true,
      },
    };
  }
}
