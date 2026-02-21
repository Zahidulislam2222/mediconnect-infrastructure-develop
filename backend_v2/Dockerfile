# --- STAGE 1: BUILDER ---
FROM node:20-alpine AS builder
WORKDIR /app

# 1. Install dependencies at the ROOT (Includes shared tools)
COPY package*.json ./
RUN npm ci

# 2. Copy all code
COPY shared ./shared
COPY doctor-service ./doctor-service

# 3. 🟢 THE FIX: Build using the ROOT compiler
WORKDIR /app/doctor-service
# We call the compiler from the root node_modules directly
RUN ../node_modules/.bin/tsc --project tsconfig.json

# --- STAGE 2: RUNNER (Production) ---
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# Copy compiled code and prod dependencies
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/doctor-service/dist ./dist
COPY --from=builder --chown=node:node /app/doctor-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

# Based on your previous tsc output: dist/doctor-service/src/index.js
CMD ["node", "dist/doctor-service/src/index.js"]