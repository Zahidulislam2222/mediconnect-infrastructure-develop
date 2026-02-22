# ==========================================
# STAGE 1: BUILDER (The "Skeleton" Approach)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# 1. SECURITY & EFFICIENCY: 
# We build a "Skeleton" of the Monorepo. 
# We copy ONLY the package.json files defined in your root "workspaces".
# This allows 'npm ci' to validate the lockfile without copying source code from other services.

COPY backend_v2/package*.json ./

# Create folders and copy manifest files for ALL workspaces defined in root package.json
COPY backend_v2/doctor-service/package.json ./doctor-service/
COPY backend_v2/patient-service/package.json ./patient-service/
COPY backend_v2/booking-service/package.json ./booking-service/
COPY backend_v2/communication-service/package.json ./communication-service/
COPY backend_v2/shared/package.json ./shared/

# Note: We do NOT copy 'ws-authorizer' because it is not listed in your root 'workspaces'.

# 2. INSTALLATION
# This will now succeed because the file structure matches the package-lock.json expectations.
RUN npm ci

# 3. COPY SOURCE CODE (Least Privilege)
# Only copy the code strictly needed for this service.
COPY backend_v2/shared ./shared
COPY backend_v2/communication-service ./communication-service

# 4. BUILD
WORKDIR /app/communication-service
RUN ../node_modules/.bin/tsc --project tsconfig.json

# 5. PRUNE (Production Optimization)
# Removes devDependencies, reducing image size and attack surface.
WORKDIR /app
RUN npm prune --omit=dev 

# ==========================================
# STAGE 2: RUNNER (Production & Compliance)
# ==========================================
FROM node:20-alpine
WORKDIR /app

# 6. SECURITY: Run as non-root user (Mandatory for HIPAA)
RUN chown -R node:node /app
USER node

# 7. COPY ARTIFACTS
# We copy the 'node_modules' from the builder, which now correctly includes hoisted packages like @azure/cosmos
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/communication-service/dist ./dist
COPY --from=builder --chown=node:node /app/communication-service/package*.json ./

ENV NODE_ENV=production
ENV PORT=8084
EXPOSE 8084

CMD ["node", "dist/communication-service/src/index.js"]