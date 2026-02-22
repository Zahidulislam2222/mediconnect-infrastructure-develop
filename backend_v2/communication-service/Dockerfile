# ==========================================
# STAGE 1: BUILDER
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. COPY MANIFESTS (The Skeleton)
COPY backend_v2/package.json ./
COPY backend_v2/package-lock.json ./ 
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package.json ./communication-service/

# NOTE: We DO NOT copy shared/package.json because it does not exist.

# 2. THE PERFECT INSTALL (npm ci)
RUN npm ci

# 3. COPY SOURCE CODE
COPY backend_v2/shared ./shared
COPY backend_v2/communication-service ./communication-service

# 4. BUILD
WORKDIR /app/communication-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 5. PRUNE
# 'npm prune' works perfectly with the lockfile to remove dev dependencies.
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER
# ==========================================
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 6. COPY ARTIFACTS
# Since we used 'npm ci' with a correct lockfile, @azure/cosmos is guaranteed to be in the root node_modules.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/communication-service/dist ./dist
COPY --from=builder --chown=node:node /app/communication-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/communication-service/src/index.js"]