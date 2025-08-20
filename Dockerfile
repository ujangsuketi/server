FROM node:18-alpine

WORKDIR /app

# Tambah build tools kalau perlu (optional, test dulu tanpa ini)
RUN apk add --no-cache python3 make g++ git

COPY package*.json ./

# Ganti ke --omit=dev
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
