FROM node:20-slim

# Install Chrome + Python + dependencies for sharp/playwright
RUN apt-get update && apt-get install -y \
    wget gnupg2 python3 python3-pip unzip curl \
    libnss3 libxss1 libasound2t64 libatk-bridge2.0-0 libgtk-3-0 \
    libgbm1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (nodriver for registration)
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install -r /tmp/requirements.txt

# Copy bridge source
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Ensure session directory exists
RUN mkdir -p .sessions

# Environment defaults
ENV NODE_ENV=production
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=10000
ENV POSTMAN_HEADLESS=true
ENV CHROME_BIN=/usr/bin/google-chrome-stable
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:10000/v1/models || exit 1

CMD ["npx", "tsx", "src/server.ts"]
