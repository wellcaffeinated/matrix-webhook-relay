FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

# Create data directories for bot state and crypto storage
RUN mkdir -p /data

VOLUME /data

ENTRYPOINT ["node", "src/index.js"]
