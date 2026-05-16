import { ProviderError } from "../errors.js";

export class FakeChatWorker {
  constructor({ id = "fake-chat", response = "fake response", failWith = null } = {}) {
    this.id = id;
    this.response = response;
    this.failWith = failWith;
  }

  async health() {
    return {
      id: this.id,
      status: this.failWith ? "unhealthy" : "ready",
      capabilities: ["chat", "vision"],
    };
  }

  async generateChat({ messages, model }) {
    if (this.failWith) {
      throw new ProviderError(this.failWith, `Fake worker failed with ${this.failWith}.`);
    }
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    return {
      content: `${this.response}${lastUser?.content ? `: ${lastUser.content}` : ""}`,
      providerMetadata: {
        worker: this.id,
        model,
        fake: true,
      },
    };
  }
}
