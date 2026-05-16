export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }

  return messages.map((message) => ({
    role: message.role || "user",
    content: normalizeContent(message.content),
  }));
}

export function messagesToPrompt(messages) {
  return normalizeMessages(messages)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

export function extractImageFilePaths(messages) {
  const paths = [];
  for (const message of messages || []) {
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part?.type !== "image_url") {
        continue;
      }
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!url) {
        continue;
      }
      if (url.startsWith("file://")) {
        paths.push(decodeURIComponent(new URL(url).pathname));
      } else if (!url.match(/^https?:\/\//i) && !url.startsWith("data:")) {
        paths.push(url);
      }
    }
  }
  return paths;
}

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }

  return content
    .map((part) => {
      if (part?.type === "text") {
        return part.text || "";
      }
      if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        return url ? `[image: ${url}]` : "[image]";
      }
      return part?.text || JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}
