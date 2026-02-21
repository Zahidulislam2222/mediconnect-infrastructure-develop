# --- STAGE 1: BUILDER (Compiles TS to JS) ---
FROM node:20-alpine AS builder
WORKDIR /app

# 1. Copy Root Files (if any shared configs exist)
COPY package*.json ./

# 2. Copy Shared Folder (CRITICAL for imports)
COPY shared ./shared

# 3. Copy Service Source
COPY patient-service ./patient-service

# 4. Install Dependencies & Build
WORKDIR /app/patient-service
RUN npm ci
RUN npm run build 
# (Result: /app/patient-service/dist/patient-service/src/index.js)

# --- STAGE 2: RUNNER (Production Image) ---
FROM node:20-alpine
WORKDIR /app

# 1. Create Non-Root User
RUN chown -R node:node /app
USER node

# 2. Copy Built Artifacts from Builder
# We copy the entire 'dist' structure to preserve paths
COPY --from=builder --chown=node:node /app/patient-service/dist ./dist
COPY --from=builder --chown=node:node /app/patient-service/package*.json ./
COPY --from=builder --chown=node:node /app/patient-service/node_modules ./node_modules

# 3. Environment Config
ENV NODE_ENV=production
ENV PORT=8081
EXPOSE 8081

# 4. Start
CMD ["node", "dist/patient-service/src/index.js"] 
# (Adjust path based on your actual tsconfig outDir. Usually it's dist/index.js)