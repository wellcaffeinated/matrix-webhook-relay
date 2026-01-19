FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install 

COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data

CMD ["node", "src/index.js"]
