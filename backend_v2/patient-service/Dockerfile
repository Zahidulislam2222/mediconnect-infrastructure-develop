# ==========================================
# STAGE 1: BUILDER (The Professional Skeleton)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. THE PROFESSIONAL FIX: Workspace Skeleton
# We copy all manifests to ensure the NPM dependency tree is calculated correctly.
COPY backend_v2/package.json ./
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package.json ./communication-service/

# 2. THE HOISTING FIX: Force Root node_modules
RUN rm -f patient-service/package-lock.json

# 3. INSTALL
# We use 'npm install' to resolve a fresh, flat tree in the cloud build context.
RUN npm install

# 4. COPY CODE & BUILD
COPY backend_v2/shared ./shared
COPY backend_v2/patient-service ./patient-service

WORKDIR /app/patient-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 5. PRUNE (Optimization)
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER (Security & Compliance)
# ==========================================
FROM node:20-alpine
WORKDIR /app

# 6. SECURITY: Non-root user (Mandatory for HIPAA/GDPR compliance)
RUN chown -R node:node /app
USER node

# 7. COPY ARTIFACTS
# We copy from the root /app/node_modules to ensure all hoisted packages are included.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/patient-service/dist ./dist
COPY --from=builder --chown=node:node /app/patient-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8081
EXPOSE 8081

CMD ["node", "dist/patient-service/src/index.js"]