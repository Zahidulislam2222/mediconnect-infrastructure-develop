# ==========================================
# STAGE 1: BUILDER (The Professional Skeleton)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. WORKSPACE SKELETON
# We copy all package manifests so the lockfile stays valid.
COPY backend_v2/package.json ./
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package.json ./communication-service/

# 2. THE HOISTING FIX
# We delete the nested lockfile if it exists to prevent "missing module" errors later.
RUN rm -f doctor-service/package-lock.json

# 3. INSTALL
# We use 'npm install' to resolve a fresh, flat tree in the cloud context.
RUN npm install

# 4. COPY CODE & BUILD
COPY backend_v2/shared ./shared
COPY backend_v2/doctor-service ./doctor-service

WORKDIR /app/doctor-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 5. PRUNE
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER (Security & Compliance)
# ==========================================
FROM node:20-alpine
WORKDIR /app

# 6. SECURITY: Non-root user for HIPAA/GDPR compliance
RUN chown -R node:node /app
USER node

# 7. COPY ARTIFACTS
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/doctor-service/dist ./dist
COPY --from=builder --chown=node:node /app/doctor-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

CMD ["node", "dist/doctor-service/src/index.js"]