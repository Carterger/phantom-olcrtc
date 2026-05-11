#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
PURPLE='\033[0;35m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${PURPLE}"
echo "  ██████╗ ██╗  ██╗ █████╗ ███╗   ██╗████████╗ ██████╗ ███╗   ███╗"
echo "  ██╔══██╗██║  ██║██╔══██╗████╗  ██║╚══██╔══╝██╔═══██╗████╗ ████║"
echo "  ██████╔╝███████║███████║██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║"
echo "  ██╔═══╝ ██╔══██║██╔══██║██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║"
echo "  ██║     ██║  ██║██║  ██║██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║"
echo "  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝"
echo -e "${NC}"
echo -e "${YELLOW}  VPN через Wildberries маскировку${NC}"
echo ""

# Проверка root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Запустите от root: sudo bash install.sh${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Проверка прав root${NC}"

# Обновление системы
echo -e "\n⏳ Обновление системы..."
apt-get update -y > /dev/null 2>&1
echo -e "${GREEN}✓ Система обновлена${NC}"

# Установка зависимостей
echo -e "\n⏳ Установка зависимостей..."
apt-get install -y curl wget git > /dev/null 2>&1
echo -e "${GREEN}✓ Зависимости установлены${NC}"

# Установка Node.js 20
echo -e "\n⏳ Установка Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y nodejs > /dev/null 2>&1
echo -e "${GREEN}✓ Node.js $(node -v) установлен${NC}"

# Создание директории
echo -e "\n⏳ Создание директории /opt/phantom..."
mkdir -p /opt/phantom
echo -e "${GREEN}✓ Директория создана${NC}"

# Скачивание remote-server.js
echo -e "\n⏳ Скачивание сервера Phantom..."
wget -q -O /opt/phantom/server.js https://raw.githubusercontent.com/Carterger/phantom-olcrtc/main/remote-server.js
echo -e "${GREEN}✓ Сервер скачан${NC}"

# Установка зависимостей сервера
echo -e "\n⏳ Установка npm зависимостей..."
cd /opt/phantom
npm init -y > /dev/null 2>&1
npm install express better-sqlite3 cors > /dev/null 2>&1
echo -e "${GREEN}✓ Зависимости npm установлены${NC}"

# Создание swap (нужен для сборки olcrtc)
echo -e "\n⏳ Создание файла подкачки (для сборки olcrtc)..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null 2>&1
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo -e "${GREEN}✓ Swap 2GB создан${NC}"
else
  echo -e "${GREEN}✓ Swap уже существует${NC}"
fi

# Установка Go
echo -e "\n⏳ Установка Go 1.24..."
wget -q https://go.dev/dl/go1.24.0.linux-amd64.tar.gz
rm -rf /usr/local/go
tar -C /usr/local -xzf go1.24.0.linux-amd64.tar.gz
rm go1.24.0.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile
echo -e "${GREEN}✓ Go $(go version | awk '{print $3}') установлен${NC}"

# Установка Mage
echo -e "\n⏳ Установка Mage..."
go install github.com/magefile/mage@latest > /dev/null 2>&1
export PATH=$PATH:/root/go/bin
echo 'export PATH=$PATH:/root/go/bin' >> /etc/profile
echo -e "${GREEN}✓ Mage установлен${NC}"

# Сборка olcrtc (долго!)
echo -e "\n⏳ ${YELLOW}Сборка OlcRTC (10-15 минут, не закрывайте терминал!)${NC}"
git clone https://github.com/openlibrecommunity/olcrtc --recurse-submodules /tmp/olcrtc > /dev/null 2>&1
cd /tmp/olcrtc
mage build
mkdir -p /opt/olcrtc
cp /tmp/olcrtc/build/olcrtc-linux-amd64 /opt/olcrtc/
chmod +x /opt/olcrtc/olcrtc-linux-amd64
rm -rf /tmp/olcrtc
echo -e "${GREEN}✓ OlcRTC собран и установлен${NC}"

# Очистка старой базы и фикс имени файла
rm -f /opt/phantom/phantom.db
mv /opt/phantom/server.js /opt/phantom/remote-server.js 2>/dev/null || true

# Создание systemd службы
cat > /etc/systemd/system/phantom.service << EOF
[Unit]
Description=Phantom VPN Manager
After=network.target

[Service]
WorkingDirectory=/opt/phantom
ExecStart=/usr/bin/node remote-server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

chmod -R 777 /opt/phantom
systemctl daemon-reload
systemctl enable phantom
systemctl restart phantom
echo -e "${GREEN}✓ Служба Phantom запущена${NC}"

# Получить IP сервера
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${PURPLE}══════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Phantom успешно установлен!${NC}"
echo -e "${PURPLE}══════════════════════════════════════${NC}"
echo ""
echo -e "  🌐 Панель API: ${YELLOW}http://${SERVER_IP}:3000${NC}"
echo ""
echo -e "  Теперь запусти приложение Phantom на ПК,"
echo -e "  введи IP ${YELLOW}${SERVER_IP}${NC} и подключись."
echo ""
