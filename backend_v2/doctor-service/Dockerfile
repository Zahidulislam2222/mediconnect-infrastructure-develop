# --- STAGE 1: BUILDER ---
FROM node:20-alpine AS builder
WORKDIR /app

# 1. Copy the monorepo package files
COPY backend_v2/package*.json ./

# 2. Create the service directory and copy its package files
RUN mkdir -p ./doctor-service
COPY backend_v2/doctor-service/package*.json ./doctor-service/

# 3. Install dependencies at the /app level
RUN npm ci

# 4. Copy the source code
COPY backend_v2/shared ./shared
COPY backend_v2/doctor-service ./doctor-service

# 5. Build
WORKDIR /app/doctor-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 6. 🟢 DOCKER 100% FIX: Prune dev dependencies at the root level!
WORKDIR /app
RUN npm prune --omit=dev 

# --- STAGE 2: RUNNER (Production) ---
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 🟢 FIXED PATH: Copy node_modules from the root /app folder, NOT doctor-service
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/doctor-service/dist ./dist
COPY --from=builder --chown=node:node /app/doctor-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

CMD ["node", "dist/doctor-service/src/index.js"]