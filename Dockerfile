FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app

# Operator tooling for `kubectl exec` debugging and for a worker's own bash tool.
# Nothing in src/ shells out to these; the coding tools reach them as the node user.
# Versions are pinned so a rebuild does not silently change what is in the pod.
ARG MISE_VERSION=2026.11.11
ARG YQ_VERSION=v4.54.3
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        unzip \
        wget \
        xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    case "$(dpkg --print-architecture)" in \
        amd64) mise_arch=x64; yq_arch=amd64 ;; \
        arm64) mise_arch=arm64; yq_arch=arm64 ;; \
        *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/yq \
        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${yq_arch}"; \
    chmod 0755 /usr/local/bin/yq; \
    curl -fsSL -o /tmp/mise.tar.gz \
        "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}.tar.gz"; \
    tar -xzf /tmp/mise.tar.gz -C /tmp mise/bin/mise; \
    install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise; \
    rm -rf /tmp/mise /tmp/mise.tar.gz; \
    git --version; jq --version; yq --version; mise --version; curl --version | head -1; wget --version | head -1

COPY --chmod=644 package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
ENV NODE_ENV=production MANOLO_DATA_DIR=/data HOST=0.0.0.0
# A restrictive checkout umask must not hide the app from the runtime user.
RUN chmod -R a+rX /app/src && install -d -o node -g node /data
USER node
CMD ["node", "src/worker.mjs"]
