FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git bash curl procps xvfb x11vnc novnc websockify \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm install -g @anthropic-ai/claude-code@2.1.143 @openai/codex@0.130.0 \
  && npx playwright install --with-deps chromium

COPY . .

ENV LLMHQ_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "src/server.js"]
