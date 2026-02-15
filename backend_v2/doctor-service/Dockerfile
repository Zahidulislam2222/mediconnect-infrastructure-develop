# --- PRODUCTION BUILD (Low RAM Optimized) ---
# We do NOT run 'tsc' here to prevent 8GB RAM crashes.
# We assume the host machine has already run 'npm run build'.

FROM node:20-alpine

# SECURITY: Run as non-root user (HIPAA/GDPR Compliance)
# Prevents container breakout attacks
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production
ENV PORT=8082

# 1. Copy Package Files
# We use --chown to ensure the 'node' user owns them
COPY --chown=node:node doctor-service/package*.json ./

# 2. Install Production Dependencies ONLY
# This is fast and uses very little RAM compared to 'npm install'
# We do this inside Docker to ensure Linux binary compatibility
RUN npm ci --omit=dev && npm cache clean --force

# 3. Copy Pre-Compiled Code (From Host)
# The 'dist' folder is created on your Windows PC and copied here.
# This structure includes both 'doctor-service' and 'shared' output.
COPY --chown=node:node doctor-service/dist ./dist

# 4. Copy Root Package (For Metadata)
COPY --chown=node:node package.json ./package.json

# 5. Expose Port
EXPOSE 8082

# 6. Start the Service
# Based on your tsconfig, the output is nested
CMD ["node", "dist/doctor-service/src/index.js"]