# The Trent MEDIA sandbox image: what the `media` toolset runs inside when this image exists
# (docs/media.md). Built as `trent-sandbox-media:<version>`; the version lives in
# packages/trent-core/src/tools/media/backend.ts. It is a SEPARATE image from the base
# sandbox (scripts/sandbox/Dockerfile), whose no-packages contract is untouched: the seats'
# terminal and execute_code still run in the inert base image, and only the five media tools
# run here, one `docker run --rm --network none --cap-drop=ALL` per call.
#
# Contents, and why each is here (01_discovery/output/market-agents-research-2026-09-19.md 3.2):
#   - ffmpeg / ffprobe            decode, probe, cut, crop, burn captions, encode;
#   - whisper.cpp (whisper-cli)   transcription with timestamps, built from a pinned tag as a
#                                 static binary (GGML_NATIVE off: a portable build for the
#                                 image's architecture, since gcc 12's -mcpu=native mis-detects
#                                 dotprod under emulation), with the ggml-base.en model bundled
#                                 so the container transcribes with no host model and no network;
#   - PySceneDetect               scene / cut detection (adaptive detector);
#   - MediaPipe + OpenCV          face detection for the 9:16 auto-reframe, with the short-range
#                                 BlazeFace model bundled.
# After the installs the package managers are removed, so nothing can be added at runtime even
# if a container ever had a network. A non-root user owns /workspace, the mount point the tools
# use, exactly as in the base image.

FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_CPP_VERSION=v1.7.5
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
    && cmake -S /src -B /src/build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /src/build --config Release -j "$(nproc)" --target whisper-cli \
    && install -m 0755 /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

FROM python:3.12-slim-bookworm
COPY --from=whisper-build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
# Models: whisper's base English model and MediaPipe's short-range face detector.
ADD https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin /opt/trent/models/ggml-base.en.bin
ADD https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite /opt/trent/models/blaze_face_short_range.tflite
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && pip install --no-cache-dir "scenedetect[opencv-headless]==0.6.6" "mediapipe==0.10.18" \
    && chmod 0644 /opt/trent/models/* \
    && adduser --disabled-password --gecos "" --uid 1000 --home /home/sandbox sandbox \
    && mkdir -p /workspace \
    && chown sandbox:sandbox /workspace \
    && rm -rf /var/lib/apt/lists/* /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg /usr/lib/apt /etc/apt \
    && rm -rf /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/ensurepip \
    && rm -rf /root/.cache

USER sandbox
WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

CMD ["sh"]
