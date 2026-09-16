FROM node:20-slim

# Install Chrome + minimal deps
RUN apt-get update && apt-get install -y \
    wget gnupg2 python3 python3-pip \
    libnss3 libxss1 libasound2t64 libatk-bridge2.0-0 libgtk-3-0 \
    libgbm1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    fonts-liberation xdg-utils \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY package*.json ./
RUN npm ci --production --ignore-scripts
COPY . .

ENV NODE_ENV=production
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=10000
ENV POSTMAN_HEADLESS=true
ENV BRIDGE_KEEPALIVE=true
ENV CHROME_BIN=/usr/bin/google-chrome-stable

EXPOSE 10000

CMD ["node", "--import", "tsx", "src/server.ts"]
