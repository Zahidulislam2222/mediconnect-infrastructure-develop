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
COPY backend_v2/communication-service/package.json ./communication-service/

# FIX 1: We DO NOT copy shared/package.json because it does not exist.
# NPM will simply ignore the empty workspace entry during install.

# 2. FIX 2: FORCE HOISTING (The "Cosmos" Fix)
# We delete the service-level lockfile. This forces NPM to install ALL dependencies
# (including @azure/cosmos) into the root /app/node_modules folder, ensuring they are saved.
RUN rm -f communication-service/package-lock.json

# 3. INSTALL
RUN npm ci

# 4. COPY SOURCE CODE
# We copy the 'shared' folder now (as code, not as a package) so TypeScript can read it.
COPY backend_v2/shared ./shared
COPY backend_v2/communication-service ./communication-service

# 5. BUILD
WORKDIR /app/communication-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 6. PRUNE
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER (Production)
# ==========================================
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 7. COPY ARTIFACTS
# Since we forced hoisting above, all production dependencies are now correctly inside this root folder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/communication-service/dist ./dist
COPY --from=builder --chown=node:node /app/communication-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/communication-service/src/index.js"]