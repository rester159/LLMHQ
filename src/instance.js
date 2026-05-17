import os from "node:os";

const startedAt = new Date().toISOString();
const instanceId = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export function llmhqInstance() {
  return {
    instance_id: instanceId,
    started_at: startedAt,
    hostname: os.hostname(),
    pid: process.pid,
  };
}
