# --- PRODUCTION BUILD (Low RAM Optimized) ---
FROM node:22-alpine

# 1. Setup Work Directory
WORKDIR /home/node/app

# 🟢 FIX: Create folders & assign permissions BEFORE switching user
# This prevents the "EACCES: permission denied" error
RUN mkdir -p node_modules dist && chown -R node:node /home/node/app

# 2. Switch to Secure User (HIPAA/GDPR Compliance)
USER node

ENV NODE_ENV=production
ENV PORT=8084

# 3. Copy Package Files
# We use --chown to ensure the 'node' user owns them
COPY --chown=node:node communication-service/package*.json ./

# 4. Install Production Dependencies
# Runs fast because we omit heavy dev dependencies
RUN npm ci --omit=dev && npm cache clean --force

# 5. Copy Pre-Compiled Code (From Windows Host)
# We copy the 'dist' folder that contains the nested structure (service + shared)
COPY --chown=node:node communication-service/dist ./dist

# 6. Copy Metadata
COPY --chown=node:node communication-service/package.json ./package.json

EXPOSE 8084

# 7. Start Service
# Uses 'npm start' to match the path defined in package.json
CMD ["npm", "start"]