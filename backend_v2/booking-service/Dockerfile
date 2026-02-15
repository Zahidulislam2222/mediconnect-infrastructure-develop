# --- PRODUCTION BUILD (Low RAM Optimized) ---
# We use Node 22 Alpine for latest security patches & small footprint
FROM node:22-alpine

# SECURITY: Run as non-root user (HIPAA/GDPR Compliance)
# Prevents container breakout attacks
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production
ENV PORT=8083

# 1. Copy Package Files
# We use --chown to ensure the 'node' user owns them
COPY --chown=node:node booking-service/package*.json ./

# 2. Install Production Dependencies ONLY
# Fast, secure, and RAM-efficient
RUN npm ci --omit=dev && npm cache clean --force

# 3. Copy Pre-Compiled Code (From Host)
# We copy the specific output folder defined in tsconfig ("dist/booking-service")
# into the container's "dist" folder.
COPY --chown=node:node booking-service/dist/booking-service ./dist

# 4. Copy Metadata
COPY --chown=node:node booking-service/package.json ./package.json

EXPOSE 8083

# 5. Start Service
# The path matches the structure created by tsconfig's "rootDir": "../" logic
# inside the dist folder we just copied.
CMD ["node", "dist/booking-service/src/index.js"]