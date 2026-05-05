FROM node:18-bullseye

# Install Chromium
RUN apt-get update && apt-get install -y chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 3000

CMD ["node", "index.js"]