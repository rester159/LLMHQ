import { createHash, randomBytes } from "node:crypto";

const label = process.argv[2] || "local-app";
const key = `llmhq_${randomBytes(32).toString("base64url")}`;
const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);

console.log(`Label: ${label}`);
console.log(`API key: ${key}`);
console.log(`Fingerprint: ${fingerprint}`);
console.log("");
console.log("Add this to .env:");
console.log(`LLMHQ_API_KEYS=${key}`);
console.log("");
console.log("Use it from apps as:");
console.log(`Authorization: Bearer ${key}`);
