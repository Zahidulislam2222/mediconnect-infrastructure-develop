# Use Node 20
FROM node:20-alpine

WORKDIR /app

# Copy shared logic and patient service
COPY package.json ./
COPY shared ./shared
COPY patient-service ./patient-service

# Install dependencies for the whole project
RUN npm install

# Move into patient service
WORKDIR /app/patient-service

# --- THIS IS THE MISSING STEP ---
# Install local dependencies and COMPILE TypeScript
RUN npm install
RUN npx tsc

# Expose the dynamic port
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]