# Build image for Shramko Motor Autostart (Betaflight 2025.12.1 + autostart patch).
# The Arm toolchain is installed once into the image; every build starts from a clean copy of the tag.
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git curl ca-certificates python3 xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*

ARG BF_TAG=2025.12.1
RUN git clone --depth 1 --branch ${BF_TAG} https://github.com/betaflight/betaflight.git /bf
WORKDIR /bf
# toolchain archive in its own cached layer (same file and path `make arm_sdk_install` expects)
RUN mkdir -p downloads && curl -fL -o downloads/arm-gnu-toolchain-13.3.rel1-x86_64-arm-none-eabi.tar.xz \n    https://developer.arm.com/-/media/Files/downloads/gnu/13.3.rel1/binrel/arm-gnu-toolchain-13.3.rel1-x86_64-arm-none-eabi.tar.xz
RUN make arm_sdk_install && ls tools && tools/*/bin/arm-none-eabi-gcc --version | head -1
RUN git config --global --add safe.directory '*'
# unit tests (Betaflight src/test uses clang + googletest)
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-rt-18-dev libblocksruntime-dev && rm -rf /var/lib/apt/lists/*
