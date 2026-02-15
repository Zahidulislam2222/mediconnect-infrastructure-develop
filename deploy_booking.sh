#!/bin/bash
# MediConnect Booking Service Deploy
# Professional Deployment with Host Compilation (Low RAM Optimized)
set -e

# Config
RG="mediconnect-rg"
ACR="zahidmediconnectacr"
SERVICE_NAME="booking-service"

# PROFESSIONAL: Immutable Tagging
IMAGE_TAG="v-$(date +%Y%m%d-%H%M%S)"

echo "🔹 Starting Professional Deployment for $SERVICE_NAME ($IMAGE_TAG)..."

# 1. HOST COMPILATION (Crucial for 8GB RAM)
echo "⚙️  Compiling TypeScript locally (Host)..."

# Navigate to service
cd backend_v2/booking-service

# Install Dev Dependencies (needed for tsc)
npm install

# Run the heavy compilation here on Windows (Better Memory Management)
npm run build

echo "✅ Compilation Complete. 'dist' folder ready."

# Navigate back to root for Docker context
cd ../..

# 2. Build & Push
echo "🔑 Logging into Registry..."
az acr login --name $ACR

echo "🐳 Building Docker Image (Packaging Only)..."
# We use the root context 'backend_v2' to allow copying the 'dist' folder correctly
docker build --no-cache \
  -t $ACR.azurecr.io/$SERVICE_NAME:$IMAGE_TAG \
  -f backend_v2/booking-service/Dockerfile \
  backend_v2

echo "☁️ Pushing to Azure..."
docker push $ACR.azurecr.io/$SERVICE_NAME:$IMAGE_TAG

# 3. Deploy
# SECURITY NOTE: We DO NOT inject local AWS keys. 
# They must be set in Azure Portal Environment Variables.
echo "🚀 Updating Container App..."
az containerapp update \
  --name $SERVICE_NAME \
  --resource-group $RG \
  --image "$ACR.azurecr.io/$SERVICE_NAME:$IMAGE_TAG" \
  --set-env-vars NODE_ENV=production

# 4. Verify
echo "⏳ Waiting for logs..."
az containerapp logs show \
  --name $SERVICE_NAME \
  --resource-group $RG \
  --tail 50 \
  --follow