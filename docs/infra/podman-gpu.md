# Enabling NVIDIA GPU for the AI services (rootless Podman)

Dyadia's only GPU-bound service is **speaches** (it serves both STT/Whisper and
TTS/Piper). Running it on GPU is optional — CPU is the default and works — but
it dramatically speeds up Whisper transcription (≈10 s → sub-second for a short
clip on this machine).

This documents the **official** NVIDIA Container Toolkit + Podman CDI setup, plus
the one SELinux step Fedora needs. Verified on: Fedora 44, Podman 5.8.2,
nvidia-ctk 1.19.1, driver 595.80, RTX 3050 Laptop.

## 1. Install the NVIDIA Container Toolkit (dnf)

```sh
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

export NVIDIA_CONTAINER_TOOLKIT_VERSION=1.19.1-1
sudo dnf install -y \
    nvidia-container-toolkit-${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
    nvidia-container-toolkit-base-${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
    libnvidia-container-tools-${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
    libnvidia-container1-${NVIDIA_CONTAINER_TOOLKIT_VERSION}
```

(Already installed on this machine — `nvidia-ctk --version` → 1.19.1.)

## 2. Generate the CDI spec (Podman's GPU passthrough mechanism)

NVIDIA recommends CDI (Container Device Interface) for Podman. Generate the spec:

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
# verify the devices Podman can see:
nvidia-ctk cdi list      # → nvidia.com/gpu=all, nvidia.com/gpu=0, ...
```

On this machine a spec already exists at `/var/run/cdi/nvidia.yaml` (Podman reads
both `/etc/cdi` and `/var/run/cdi`). Regenerate after a driver update.

## 3. SELinux — REQUIRED on Fedora (the key step)

Fedora runs SELinux **Enforcing**, whose default policy forbids containers from
touching `/dev/nvidia*` — even though the device DAC perms are `rw-rw-rw-`. The
symptom is, despite CDI injecting the devices:

```
Failed to initialize NVML: Insufficient Permissions
```

Official fix — flip the `container_use_devices` boolean (persistent, one-time):

```sh
sudo setsebool -P container_use_devices on
```

Verify: `getsebool container_use_devices` → `container_use_devices --> on`.

(Avoid the alternatives `chcon -t container_file_t /dev/nvidia*` — resets on
reboot — and `--security-opt=label=disable` — disables SELinux separation.)

Smoke test (should print the GPU name, not the NVML error):

```sh
podman run --rm --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L
```

## 4. Run the AI service on GPU

Switching is **one knob** — applying the overlay. `compose.gpu.yml` is
self-sufficient (it overrides the image tag → `:latest-cuda`, the inference device
→ `cuda`, and attaches the CDI device), so you do **not** edit `AI_DEVICE`, and
**richter needs no change** (it talks HTTP to speaches and is device-agnostic).

```sh
# start speaches on GPU (pulls :latest-cuda the first time, attaches the GPU)
podman compose -f compose.yml -f compose.gpu.yml up -d speaches
# confirm the GPU is in use
nvidia-smi            # the speaches/python process should appear
```

`compose.gpu.yml` adds `WHISPER__COMPUTE_TYPE=float16` and the CDI device:

```yaml
services:
  speaches:
    devices:
      - nvidia.com/gpu=all      # maps to `--device nvidia.com/gpu=all`
```

**Use the `devices:` field, NOT `deploy.resources.reservations.devices`.** The
Docker-Swarm `deploy.resources` GPU form (`driver: nvidia`) is silently ignored by
podman compose ([containers/podman#19338](https://github.com/containers/podman/issues/19338)) —
the container would come up on CPU with no error. The `devices: nvidia.com/gpu=all`
CDI form is what actually attaches the GPU. Without the toolkit + CDI spec + the
SELinux boolean, podman errors on the unknown CDI device instead of silently
falling back.

## 5. Revert to CPU (the safe default)

The base stack is always CPU — just bring speaches up WITHOUT the overlay:

```sh
podman compose up -d speaches
```

## Sources
- [NVIDIA Container Toolkit — Install Guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- [NVIDIA Container Toolkit — Troubleshooting (NVML Insufficient Permissions / SELinux)](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/troubleshooting.html)
- [Podman Desktop — GPU container access](https://podman-desktop.io/docs/podman/gpu)
- [Fedora Discussion — nvidia-container-toolkit without disabling SELinux](https://discussion.fedoraproject.org/t/how-to-use-nvidia-container-toolkit-without-disabling-selinux/125970)
