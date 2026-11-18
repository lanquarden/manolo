FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
ENV NODE_ENV=production MANOLO_DATA_DIR=/data HOST=0.0.0.0
RUN install -d -o node -g node /data
USER node
CMD ["node", "src/worker.mjs"]
