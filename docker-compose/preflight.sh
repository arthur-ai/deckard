#!/usr/bin/env bash
# Check this machine can run the Docker Compose quickstart, before anything is started.
#
# Usage: ./preflight.sh
#
# Only reads: it installs, starts and changes nothing, and never needs root. Each failed
# check is printed with the command(s) to fix it, which you run yourself; then run this
# again. Exits 0 when nothing failed. The agent setup prompt
# (docs/agent-setup/prompt.md) runs it first.

set -uo pipefail

failed=0
check() { printf 'CHECK %-12s %-4s %s\n' "$1" "$2" "$3"; [ "$2" != FAIL ] || failed=$((failed + 1)); }
fix() { local line; for line in "$@"; do printf '      FIX: %s\n' "$line"; done; }

os="$(uname -s)"
arch="$(uname -m)"
pm=""
if [ "$os" = Linux ]; then
  if command -v apt-get >/dev/null 2>&1; then pm=apt
  elif command -v dnf >/dev/null 2>&1; then pm=dnf; fi
fi
# The command that installs system packages $*, for the user to run.
install_cmd() {
  case "$os/$pm" in
    Darwin/*) echo "brew install $*" ;;
    Linux/apt) echo "sudo apt-get install -y $*" ;;
    Linux/dnf) echo "sudo dnf install -y $*" ;;
    *) echo "install $* with your package manager" ;;
  esac
}

case "$os" in
  Darwin|Linux) check os PASS "$os $arch" ;;
  *) check os FAIL "$os is not supported"
     fix "Run this on macOS or Linux. On Windows, run it inside WSL2 with Docker Desktop's WSL integration turned on." ;;
esac

missing=""
for tool in git curl tar; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || missing="$missing coreutils"
if [ -z "$missing" ]; then
  check tools PASS "git, curl, tar, sha256"
elif [ "$os" = Darwin ]; then
  check tools FAIL "missing:$missing"; fix "xcode-select --install"
else
  check tools FAIL "missing:$missing"; fix "$(install_cmd "${missing# }")"
fi

if curl -fsS -o /dev/null --max-time 15 https://raw.githubusercontent.com/arthur-ai/deckard/main/README.md; then
  check network PASS "raw.githubusercontent.com reachable"
else
  check network FAIL "cannot reach raw.githubusercontent.com, where scan-local.sh downloads the collector"
  fix "Behind a proxy, export HTTPS_PROXY in the terminal you run this from, and set the same proxy in Docker's settings for image pulls."
fi

# How to start the Docker this machine has, for the user to run.
start_docker() {
  if [ "$os" = Darwin ]; then
    if [ -d /Applications/Docker.app ]; then echo "open -a Docker"
    elif [ -d /Applications/OrbStack.app ]; then echo "open -a OrbStack"
    elif command -v colima >/dev/null 2>&1; then echo "colima start --cpu 4 --memory 6"
    elif [ -d "/Applications/Rancher Desktop.app" ]; then echo "open -a 'Rancher Desktop'   (with the dockerd (moby) engine)"
    else echo "start your Docker runtime"; fi
  elif systemctl --user cat docker-desktop >/dev/null 2>&1; then echo "systemctl --user start docker-desktop"
  elif [ -d /run/systemd/system ]; then echo "sudo systemctl enable --now docker"
  else echo "sudo service docker start"; fi
}

# Where Docker Desktop, OrbStack, Rancher Desktop and Homebrew put the docker command, in
# case this shell's PATH (often a coding agent's) leaves it out.
docker_off_path=""
for c in /usr/local/bin/docker "$HOME/.docker/bin/docker" /opt/homebrew/bin/docker \
         "$HOME/.orbstack/bin/docker" "$HOME/.rd/bin/docker" \
         /Applications/Docker.app/Contents/Resources/bin/docker; do
  if [ -x "$c" ]; then docker_off_path="$c"; break; fi
done
# The startup file every new shell of the user's reads, so a coding agent's shells get it too.
# The ~ is for the user to type, not for this script to expand.
# shellcheck disable=SC2088
case "${SHELL##*/}" in
  zsh) rcfiles="~/.zshenv" ;;
  bash) rcfiles="~/.bash_profile ~/.bashrc" ;;   # login and interactive bash read different files
  *) rcfiles="" ;;
esac

docker_ok=false
if ! command -v docker >/dev/null 2>&1 && [ -n "$docker_off_path" ]; then
  check docker FAIL "docker is installed at $docker_off_path but not on this shell's PATH"
  # An export typed in the user's terminal never reaches the agent's shell: it has to go
  # in a startup file, and the agent has to start again to read it.
  if [ -n "$rcfiles" ]; then
    for rc in $rcfiles; do fix "echo 'export PATH=\"$(dirname "$docker_off_path"):\$PATH\"' >> $rc"; done
  else
    fix "Add $(dirname "$docker_off_path") to PATH in your shell's startup file."
  fi
  fix "Then restart your coding agent (or open a new terminal), and run this again."
elif ! command -v docker >/dev/null 2>&1; then
  check docker FAIL "Docker is not installed"
  if [ "$os" = Darwin ]; then
    fix "Install and start one of: Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/)," \
        "OrbStack (brew install --cask orbstack), or Colima (brew install colima docker docker-compose && colima start --cpu 4 --memory 6)."
  else
    fix "Install Docker Engine with its Compose plugin: https://docs.docker.com/engine/install/" \
        "Then let your user run it: sudo usermod -aG docker \"\$USER\", and log out and back in."
  fi
elif ! info="$(docker info --format '{{.ServerVersion}}|{{.MemTotal}}|{{.NCPU}}|{{.DockerRootDir}}|{{.OperatingSystem}}' 2>&1)"; then
  case "$info" in
    *"ermission denied"*)
      check docker FAIL "your user may not use the Docker socket"
      fix "sudo usermod -aG docker \"\$USER\"" "Then log out and back in, and run this again from a new terminal." ;;
    *)
      check docker FAIL "Docker is installed but not running"
      fix "$(start_docker)" "Once it is up, docker info should answer. If it still doesn't, docker context ls: the starred context must be the Docker that is running (docker context use <name>)." ;;
  esac
else
  docker_ok=true
  IFS='|' read -r server mem ncpu root dos <<EOF
$info
EOF
  check docker PASS "server $server, $dos, $ncpu CPUs"

  mib=$((mem / 1024 / 1024))
  memfix="Docker Desktop: Settings > Resources > Memory, 6 GB or more. Colima: colima stop && colima start --cpu 4 --memory 6. Linux: free memory on this machine."
  if [ "$mib" -lt 3800 ]; then check memory FAIL "$mib MiB for Docker; Elasticsearch and Deckard need 4 GiB"; fix "$memfix"
  elif [ "$mib" -lt 5800 ]; then check memory WARN "$mib MiB for Docker; 6 GiB or more is better"
  else check memory PASS "$mib MiB"; fi

  # Docker Desktop and the macOS runtimes keep images in a VM whose disk the host can't see.
  if [ "$os" = Linux ] && [ "${dos#Docker Desktop}" = "$dos" ] && df -Pk "$root" >/dev/null 2>&1; then
    read -r size avail <<EOF
$(df -Pk "$root" | awk 'NR == 2 {print $2, $4}')
EOF
    gib=$((avail / 1024 / 1024))
    # Used the way Elasticsearch counts it, size minus available: more than df's Use% where
    # space is reserved. The Compose file turns its disk watermarks off for this demo.
    pct=$((100 - avail * 100 / size))
    diskfix="Free space at $root. docker system df shows Docker's own use; docker system prune removes stopped containers and unused images."
    if [ "$gib" -lt 5 ]; then check disk FAIL "$gib GiB free at $root; the images and data need about 6 GiB"; fix "$diskfix"
    elif [ "$gib" -lt 10 ]; then check disk WARN "$gib GiB free at $root ($pct% used); the first start downloads about 1.4 GB, 4.5 GB unpacked"
    else check disk PASS "$gib GiB free at $root ($pct% used by Elasticsearch's count)"; fi
  else
    check disk INFO "inside Docker's VM, not measurable here: it needs about 6 GiB free"
  fi
fi

# The Compose plugin answers without the daemon.
if command -v docker >/dev/null 2>&1; then
  cv="$(docker compose version --short 2>/dev/null)"
  cv="${cv#v}"
  major="${cv%%.*}"; rest="${cv#*.}"; minor="${rest%%.*}"
  case "$os" in
    Darwin) composefix="Update Docker Desktop or OrbStack. With Homebrew's Docker: brew install docker-compose, then mkdir -p ~/.docker/cli-plugins && ln -sfn \"\$(brew --prefix)/opt/docker-compose/bin/docker-compose\" ~/.docker/cli-plugins/docker-compose" ;;
    *) composefix="$(install_cmd docker-compose-plugin)   (from Docker's own package repository: https://docs.docker.com/engine/install/)" ;;
  esac
  if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
    check compose FAIL "the Docker Compose plugin (docker compose) is not installed"; fix "$composefix"
  elif [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 24 ]; }; then
    check compose PASS "$cv"
  else
    check compose FAIL "Compose $cv is older than 2.24, which this Compose file needs"; fix "$composefix"
  fi
fi

for port in 9200 7493; do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$port"
  if [ $? -eq 7 ]; then
    check "port-$port" PASS "free"
  elif [ "$docker_ok" = true ] && [ "$(docker ps --filter "publish=$port" --format '{{.Label "com.docker.compose.project"}}' | head -n 1)" = arthur-deckard ]; then
    check "port-$port" PASS "Deckard's own Compose stack is running"
  elif [ "$docker_ok" = false ]; then
    # Without a working docker command there's no telling whether this is Deckard's own stack.
    check "port-$port" INFO "in use; checked again once the docker check passes (see what: lsof -nP -iTCP:$port -sTCP:LISTEN)"
  else
    check "port-$port" FAIL "something else listens on 127.0.0.1:$port"
    fix "See what: lsof -nP -iTCP:$port -sTCP:LISTEN (or docker ps --filter publish=$port), and stop it."
  fi
done

osqueryi=""
for c in "${OSQI:-}" /usr/local/bin/osqueryi /opt/osquery/lib/osquery.app/Contents/MacOS/osqueryi \
         /usr/bin/osqueryi "$(command -v osqueryi 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then osqueryi="$c"; break; fi
done
if [ -n "$osqueryi" ]; then
  check osquery PASS "$("$osqueryi" --version 2>/dev/null | head -n 1)"
else
  check osquery FAIL "osquery is not installed; scan-local.sh needs its osqueryi"
  v=5.24.0
  rel="https://github.com/osquery/osquery/releases/download/$v"
  case "$os/$pm/$arch" in
    Darwin/*) fix "brew install --cask osquery   (or the .pkg from https://osquery.io/downloads)" ;;
    Linux/apt/x86_64) fix "curl -fsSLo /tmp/osquery.deb $rel/osquery_$v-1.linux_amd64.deb && echo '8ae0416d85336a1aea6883920ae9c2751a98538fe0bb624822e92934d3be5592  /tmp/osquery.deb' | sha256sum -c - && sudo dpkg -i /tmp/osquery.deb" ;;
    Linux/apt/aarch64) fix "curl -fsSLo /tmp/osquery.deb $rel/osquery_$v-1.linux_arm64.deb && echo 'ee737e5d2d0c011ed5a15883f930c5df4913365e12b262598d3250ce1340645c  /tmp/osquery.deb' | sha256sum -c - && sudo dpkg -i /tmp/osquery.deb" ;;
    Linux/dnf/x86_64) fix "curl -fsSLo /tmp/osquery.rpm $rel/osquery-$v-1.linux.x86_64.rpm && echo '27fd7a2b6e79e4f6f86d7af2f5b016bc20d42693bd9818258f29c348f13b79f6  /tmp/osquery.rpm' | sha256sum -c - && sudo rpm -i /tmp/osquery.rpm" ;;
    Linux/dnf/aarch64) fix "curl -fsSLo /tmp/osquery.rpm $rel/osquery-$v-1.linux.aarch64.rpm && echo 'dac0632d82f33177a67d05c033032097c97db3f60110aad1c0a1f395ae9c9d40  /tmp/osquery.rpm' | sha256sum -c - && sudo rpm -i /tmp/osquery.rpm" ;;
    *) fix "Install osquery 5.x from https://osquery.io/downloads. Elsewhere than /usr/bin or /usr/local/bin, run OSQI=/path/to/osqueryi ./scan-local.sh" ;;
  esac
fi

if [ "$os" = Linux ]; then
  if [ -s /etc/machine-id ] || [ -s /var/lib/dbus/machine-id ]; then
    check machine-id PASS ""
  else
    check machine-id FAIL "no /etc/machine-id, which scan-local.sh names this machine by"
    fix "sudo systemd-machine-id-setup   (without systemd: dbus-uuidgen | sudo tee /etc/machine-id)"
  fi
fi

if [ "$(id -u)" = 0 ]; then
  check user INFO "running as root: the scan sees root's own tools, not another user's"
fi

if [ "$failed" -eq 0 ]; then
  echo "PREFLIGHT OK"
else
  echo "PREFLIGHT FAILED: $failed check(s). Run each FIX yourself, then run this again."
  exit 1
fi
