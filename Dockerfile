FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache postgresql16-client

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4200
CMD ["node", "src/server.js"]
