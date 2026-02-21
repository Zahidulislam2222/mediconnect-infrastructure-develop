# --- STAGE 1: BUILDER ---
FROM node:20-alpine AS builder
WORKDIR /app

# 1. 🟢 FIX: Copy the monorepo package files from the correct subfolder
COPY backend_v2/package*.json ./

# 2. 🟢 FIX: Create the service directory and copy its package files
RUN mkdir -p ./doctor-service
COPY backend_v2/doctor-service/package*.json ./doctor-service/

# 3. Install dependencies at the /app level
RUN npm ci

# 4. Copy the source code (Shared tools + Doctor Service)
COPY backend_v2/shared ./shared
COPY backend_v2/doctor-service ./doctor-service

# 5. Build using the compiler in /app/node_modules
WORKDIR /app/doctor-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# --- STAGE 2: RUNNER (Production) ---
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 🟢 FIXED: We now copy the entire dist folder to preserve the relative 
# path (../../shared/logger) required by your index.ts imports.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/doctor-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

# 🟢 FIXED: Point to the absolute path in the unified dist folder
CMD ["node", "dist/doctor-service/src/index.js"]