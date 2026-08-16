FROM node:20-alpine
WORKDIR /app
COPY package*.json .
RUN npm ci --omit=dev
COPY server.js .
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3210
CMD ["node", "server.js"]
