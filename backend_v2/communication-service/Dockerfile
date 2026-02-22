# ==========================================
# STAGE 1: BUILDER
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. COPY MANIFESTS (The Skeleton)
COPY backend_v2/package*.json ./
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package*.json ./communication-service/
COPY backend_v2/shared/package.json ./shared/

# 2. THE FIX: REMOVE NESTED LOCKFILE
# We delete the service-level lockfile to force NPM to install ALL dependencies
# into the root /app/node_modules folder. This guarantees they are copied later.
RUN rm -f communication-service/package-lock.json

# 3. INSTALL & BUILD
RUN npm ci

# Copy source code
COPY backend_v2/shared ./shared
COPY backend_v2/communication-service ./communication-service

WORKDIR /app/communication-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 4. PRUNE
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER
# ==========================================
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 5. COPY ARTIFACTS
# Since we forced hoisting above, @azure/cosmos is GUARANTEED to be in this node_modules folder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/communication-service/dist ./dist
COPY --from=builder --chown=node:node /app/communication-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/communication-service/src/index.js"]