# --- PRODUCTION BUILD (Low RAM Optimized) ---
FROM node:20-alpine

# 1. Setup Work Directory
WORKDIR /home/node/app

# 🟢 FIX: Create folders & assign permissions BEFORE switching user
RUN mkdir -p node_modules dist && chown -R node:node /home/node/app

# 2. Switch to Secure User
USER node

# 🟢 KEEP PORT 8081
ENV NODE_ENV=production
ENV PORT=8081

# 3. Copy Package Files
COPY --chown=node:node patient-service/package*.json ./

# 4. Install Production Dependencies
RUN npm ci --omit=dev && npm cache clean --force

# 5. Copy Pre-Compiled Code
COPY --chown=node:node patient-service/dist ./dist

# 6. Copy Metadata
COPY --chown=node:node patient-service/package.json ./package.json

EXPOSE 8081

# 7. Start Service
# Points exactly to where your tsconfig outputs the file
CMD ["node", "dist/patient-service/src/index.js"]