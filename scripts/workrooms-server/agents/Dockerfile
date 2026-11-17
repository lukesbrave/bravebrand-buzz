# Agents that run on the server: Buzz's own headless agent runner (buzz-acp)
# driving OpenAI's Codex through its ACP adapter. Built on the server, so
# nothing here is redistributed. buzz-acp and the buzz command are built from
# the same revision as the relay image setup.sh pins, so they speak the same
# protocol. agents/bridge.mjs starts one container from this image per agent.
ARG RUST_VERSION=1.98.1
FROM rust:${RUST_VERSION}-slim-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential cmake pkg-config libssl-dev ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ARG BUZZ_REV=2c5c8343ef8c39cad0cb27cbc07bffc7141e345a
RUN cargo install --locked --git https://github.com/block/buzz.git --rev ${BUZZ_REV} \
        --root /out buzz-acp buzz-cli

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git libssl3 \
    && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=0.169.0
ARG CODEX_ACP_VERSION=2.1.1
RUN npm install -g --no-fund --no-audit \
        @openai/codex@${CODEX_VERSION} \
        @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} \
    && npm cache clean --force
COPY --from=build /out/bin/buzz-acp /out/bin/buzz /usr/local/bin/
RUN useradd --create-home --uid 10001 --shell /bin/bash helper \
    && mkdir -p /home/helper/workspace /home/helper/.codex \
    && chown -R helper:helper /home/helper
# Each start: publish the agent's name and picture as the agent, then run. The
# bridge only writes the settings and starts the container, so the app's
# request returns at once.
RUN printf '%s\n' '#!/bin/sh' \
        'BUZZ_RELAY_URL="https://${BUZZ_RELAY_URL#wss://}" buzz users set-profile --name "$AGENT_NAME" ${AGENT_AVATAR:+--avatar "$AGENT_AVATAR"} >/dev/null 2>&1 || echo "profile not published; will retry on the next start" >&2' \
        'exec buzz-acp "$@"' >/usr/local/bin/agent-start \
    && chmod 755 /usr/local/bin/agent-start
USER helper
WORKDIR /home/helper/workspace
# The adapter runs this Codex, signed in under CODEX_HOME. The container is the
# boundary, so Codex itself runs without its own sandbox or approval prompts.
ENV HOME=/home/helper \
    CODEX_HOME=/home/helper/.codex \
    CODEX_PATH=/usr/local/bin/codex \
    INITIAL_AGENT_MODE=agent-full-access
ENTRYPOINT ["agent-start"]
