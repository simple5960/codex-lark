#!/usr/bin/env bash
# Ubuntu 22.04 EC2 user-data. Run as root on a dedicated instance.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
umask 022

apt-get update
apt-get install -y ca-certificates curl xz-utils git bubblewrap

# Pin Node and verify the download against the official distribution checksum.
NODE_VERSION=v22.23.4
NODE_ARCH=x64
case "$(uname -m)" in aarch64) NODE_ARCH=arm64 ;; esac
NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
cd /tmp
curl --fail --retry 3 -LO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
curl --fail --retry 3 -LO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
awk -v file="$NODE_ARCHIVE" '$2 == file' SHASUMS256.txt | sha256sum -c -
tar -xJf "$NODE_ARCHIVE" -C /usr/local --strip-components=1

npm install --global @openai/codex@0.170.0 --registry=https://registry.npmjs.org --no-audit --no-fund
codex --version

id codex >/dev/null 2>&1 || useradd --create-home --shell /bin/bash codex
install -d -o root -g root -m 755 /opt/codex-lark
git clone --branch main --single-branch https://github.com/simple5960/codex-lark.git /opt/codex-lark
cd /opt/codex-lark
git checkout "${CODEX_LARK_REVISION:-main}"
# Use the official npm registry on AWS, preserving package integrity checks.
python3 - <<'PY'
from pathlib import Path
p = Path('package-lock.json')
p.write_text(p.read_text().replace('https://registry.npmmirror.com/', 'https://registry.npmjs.org/'))
PY
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org

install -d -o codex -g codex -m 700 /opt/codex-lark/.data /home/codex/.codex
install -d -o codex -g codex -m 755 /srv/codex
sudo -u codex git clone https://github.com/simple5960/codex-lark.git /srv/codex/workspace
cat > /home/codex/.codex/config.toml <<'EOF'
cli_auth_credentials_store = "file"
EOF
chown codex:codex /home/codex/.codex/config.toml
chmod 600 /home/codex/.codex/config.toml
cat > /opt/codex-lark/.env.prod <<'EOF'
AWS_REGION=us-west-2
AWS_SECRET_ID=simple-codex
LARK_DOMAIN=lark
ALLOWED_OPEN_IDS=ou_e988b0efe35f221758d3e6565ef5deb8
CODEX_WORKSPACE=/srv/codex/workspace
CODEX_SANDBOX=workspace-write
CODEX_EXECUTABLE=/usr/local/bin/codex
MAX_PARALLEL_TASKS=2
MAX_QUEUED_TASKS=20
EOF
chown root:codex /opt/codex-lark/.env.prod
chmod 640 /opt/codex-lark/.env.prod

cat > /etc/systemd/system/codex-lark.service <<'EOF'
[Unit]
Description=Lark chat bridge to Codex
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=codex
Group=codex
WorkingDirectory=/opt/codex-lark
Environment=HOME=/home/codex
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/bin/rm -f /opt/codex-lark/.data/state.json.lock
ExecStart=/usr/local/bin/node /opt/codex-lark/src/index.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

# Headroom for dependency installs and Codex on a small instance.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
systemctl daemon-reload
systemctl enable --now codex-lark
echo 'codex-lark bootstrap complete; sign in as the codex user before running tasks.'
