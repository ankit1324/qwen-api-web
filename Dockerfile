FROM node:20-slim

# Chrome is required to generate real baxia tokens (bx-ua/bx-umidtoken)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 8081

CMD ["npm", "run", "serve"]
