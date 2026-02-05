FROM node:20-alpine

WORKDIR /app

# Copy root deps
COPY package.json ./

# Copy Shared logic (Compliance/Logger)
COPY shared ./shared

# Copy Doctor Service source
COPY doctor-service ./doctor-service

# Install dependencies for the whole project context
RUN npm install

# Move into service folder
WORKDIR /app/doctor-service

# Install local dependencies and COMPILE TypeScript
RUN npm install
RUN npx tsc

# Set production environment and port
ENV NODE_ENV=production
ENV PORT=8082
EXPOSE 8082

# Run the COMPILED javascript, not the typescript source
CMD ["node", "dist/index.js"]