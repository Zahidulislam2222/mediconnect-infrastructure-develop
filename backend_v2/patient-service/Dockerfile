# --- STAGE 1: BUILDER ---
FROM node:20-alpine AS builder
WORKDIR /app

# 1. Copy the monorepo root package files
COPY package*.json ./

# 2. Copy the patient-service package files into their own folder
RUN mkdir -p ./patient-service
COPY patient-service/package*.json ./patient-service/

# 3. 🟢 THE FIX: Install dependencies INSIDE the patient-service folder
# This ensures socket.io and mqtt are physically installed where the code needs them
WORKDIR /app/patient-service
RUN npm install

# 4. Copy the source code (Shared and Service)
WORKDIR /app
COPY shared ./shared
COPY patient-service ./patient-service

# 5. Build the Service
WORKDIR /app/patient-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# --- STAGE 2: RUNNER ---
FROM node:20-alpine
WORKDIR /app

# Security: Run as non-root
RUN chown -R node:node /app
USER node

# 🟢 THE FIX: Copy node_modules from the SERVICE folder, not the root
# This guarantees that the runtime finds 'socket.io'
COPY --from=builder --chown=node:node /app/patient-service/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/patient-service/dist ./dist
COPY --from=builder --chown=node:node /app/patient-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8081
EXPOSE 8081

# 🟢 THE FIX: Point the CMD to the exact path where the compiler puts the file
CMD ["node", "dist/patient-service/src/index.js"]