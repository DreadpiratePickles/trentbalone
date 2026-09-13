# The Trent sandbox image: what `execute_code` and `terminal` run inside when the backend is
# Docker. Built by `trent sandbox build` (and by .github/workflows/sandbox.yml) as
# `trent-sandbox:<version>`; the version lives in packages/trent-core/src/terminal/sandbox-image.ts.
#
# Deliberately small and deliberately inert:
#   - alpine pinned to a minor release, python3 and nodejs from its repositories, nothing else
#     (no pip, no npm: a seat that needs a package asks the founder, it does not fetch one);
#   - the package manager is removed after the install, so nothing can be added at runtime even
#     if a seat finds a way to reach the network (the backend runs the container with
#     --network none unless egress is proxied, --cap-drop=ALL and no-new-privileges);
#   - a non-root user owns /workspace, the mount point the tools use. On Linux hosts DockerBackend
#     overrides it with `--user <host uid>:<gid>` and `HOME=/tmp`, because a bind mount keeps the
#     host's ownership and --cap-drop=ALL removes CAP_DAC_OVERRIDE; /home/sandbox stays uid 1000's.
FROM alpine:3.20

RUN apk add --no-cache python3 nodejs \
    && rm -f /sbin/apk \
    && rm -rf /etc/apk /lib/apk /var/cache/apk /usr/share/apk \
    && adduser -D -u 1000 -h /home/sandbox sandbox \
    && mkdir -p /workspace \
    && chown sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_OPTIONS=--max-old-space-size=256

CMD ["sh"]
