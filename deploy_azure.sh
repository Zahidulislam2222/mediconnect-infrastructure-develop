#!/bin/bash
# MediConnect Enterprise Azure Deploy
# Optimization: Pre-builds TypeScript on Host to save Docker RAM
set -e

# 1. Configuration
RG="mediconnect-rg"
ACR="zahidmediconnectacr"
APP_NAME="doctor-service"
IMAGE_TAG="v-$(date +%Y%m%d-%H%M%S)"

echo "🔹 Starting Professional Deployment for $APP_NAME..."

# 2. HOST COMPILATION (Crucial for 8GB RAM)
echo "⚙️  Compiling TypeScript locally (Host)..."

# Navigate to service
cd backend_v2/doctor-service

# Install Dev Dependencies (needed for tsc)
# If you already have node_modules, this is fast.
npm install

# Run the heavy compilation here on Windows (Better Memory Management)
npm run build

echo "✅ Compilation Complete. 'dist' folder ready."

# Navigate back to root for Docker context
cd ../..

# 3. Docker Build & Push
echo "🔑 Logging into Azure Registry..."
az acr login --name $ACR

echo "🐳 Building Docker Image (Packaging Only)..."
# We use the root 'backend_v2' context so we can grab the 'dist' folder
docker build --no-cache \
  -t $ACR.azurecr.io/$APP_NAME:$IMAGE_TAG \
  -f backend_v2/doctor-service/Dockerfile \
  backend_v2

echo "☁️ Pushing to Azure Container Registry..."
docker push $ACR.azurecr.io/$APP_NAME:$IMAGE_TAG

# 4. Deploy to Container Apps
echo "🚀 Updating Container App Revision..."
az containerapp update \
  --name $APP_NAME \
  --resource-group $RG \
  --image "$ACR.azurecr.io/$APP_NAME:$IMAGE_TAG" \
  --set-env-vars NODE_ENV=production

# 5. Verification
echo "🎯 Deployment Triggered Successfully."
echo "🔍 Fetching Live Logs (Ctrl+C to exit log stream)..."
az containerapp logs show \
  --name $APP_NAME \
  --resource-group $RG \
  --tail 50 \
  --follow