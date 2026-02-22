# ==========================================
# STAGE 1: BUILDER
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. COPY MANIFESTS (The Skeleton)
COPY backend_v2/package.json ./
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package.json ./communication-service/

# FIX 1: IGNORE LOCAL LOCKFILES

RUN rm -f package-lock.json
RUN rm -f communication-service/package-lock.json

# FIX 2: REGENERATE FLAT TREE

RUN npm install

# 2. COPY SOURCE CODE
# We copy the 'shared' folder as source code (since it has no package.json)
COPY backend_v2/shared ./shared
COPY backend_v2/communication-service ./communication-service

# 3. BUILD
WORKDIR /app/communication-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 4. PRUNE
# Removes dev dependencies while keeping the flat structure
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER (Production)
# ==========================================
FROM node:20-alpine
WORKDIR /app
RUN chown -R node:node /app
USER node

# 5. COPY ARTIFACTS
# Because we used "npm install" above, @azure/cosmos is now guaranteed to be in this root folder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/communication-service/dist ./dist
COPY --from=builder --chown=node:node /app/communication-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/communication-service/src/index.js"]