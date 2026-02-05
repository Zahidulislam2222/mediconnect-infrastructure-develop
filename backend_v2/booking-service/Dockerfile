FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build
RUN npm prune --production

EXPOSE 8080

USER node

CMD ["npm", "start"]
