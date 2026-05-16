export class ProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

export function toProviderError(error) {
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError("provider_error", error?.message || "Provider failed");
}
